// concern: monitor-writer-fallback-bound
/** Reports writers recorded ok from a fallback reply after the wall bound killed them. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { resolveRecordedRunJob } from '../jobs/jobs.ts'
import { FINAL_MESSAGE_FALLBACK_MARKER } from '../run/run-live.ts'
import type { MonitorCondition } from './monitor-types.ts'

const WRITER_FALLBACK_BOUND_LOOKBACK_MS = 24 * 60 * 60_000

type WriterFallbackBoundRow = {
  record_id: string
  started_at: string
  session_id: string | null
  job: string
  branch: string | null
  minted_branch: string | null
}

function writerFallbackBoundRows(database: Database, clock: number): WriterFallbackBoundRow[] {
  const cutoff = new Date(clock - WRITER_FALLBACK_BOUND_LOOKBACK_MS).toISOString()
  return database
    .query(
      `SELECT record_id,started_at,session_id,job,branch,minted_branch
         FROM run
        WHERE status='ok' AND exit_code=143
          AND error LIKE '%${FINAL_MESSAGE_FALLBACK_MARKER}%'
          AND started_at>=?
        ORDER BY started_at,record_id`,
    )
    .all(cutoff) as WriterFallbackBoundRow[]
}

export function writerOkOnFallbackAtBoundConditions(
  database: Database = db(),
  clock = Date.now(),
): MonitorCondition[] {
  return writerFallbackBoundRows(database, clock).flatMap((row): MonitorCondition[] => {
    if (!resolveRecordedRunJob(row).writesRepo) return []
    return [
      {
        kind: 'writer-ok-on-fallback-at-bound',
        subject: `run:${row.record_id}`,
        since: row.started_at,
        ageMs: null,
        detail: `writing run ${row.record_id} was recorded ok from the final-message fallback after exit 143`,
        action: `inspect run ${row.record_id} and correct its terminal classification`,
        ownerSession: row.session_id,
      },
    ]
  })
}
