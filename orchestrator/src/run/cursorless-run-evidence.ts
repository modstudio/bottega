// concern: cursorless run evidence
/** Reads first-turn jobs that have neither a task key nor a workflow cursor binding. */

import type { Database } from 'bun:sqlite'
import { JOBS } from '../jobs/jobs.ts'

const CURSORLESS_RUN_FAMILY_PREDICATE = `launch_key IS NULL
          AND cursor_record_id IS NULL
          AND COALESCE(turn,1)=1`

export type CursorlessRunEvidence = {
  number: number
  job: string
  session: string | null
  at: string
  probe: boolean
}

export type FailedBeforeClaimRunEvidence = {
  day: string
  count: number
}

export function cursorlessRunEvidence(database: Database, from: string): CursorlessRunEvidence[] {
  return database
    .query<Omit<CursorlessRunEvidence, 'probe'> & { probe: number }, [string]>(
      `SELECT number,job,session_id session,started_at at,probe=1 probe
         FROM run
        WHERE ${CURSORLESS_RUN_FAMILY_PREDICATE}
          AND NOT (agent='(pending)' AND status='failed')
          AND started_at>=?
        ORDER BY number`,
    )
    .all(from)
    .filter((run) => Object.hasOwn(JOBS, run.job))
    .map((run) => ({ ...run, probe: run.probe === 1 }))
}

type FailedBeforeClaimRunEvidenceRow = FailedBeforeClaimRunEvidence & { job: string }

export function failedBeforeClaimRunEvidence(
  database: Database,
  from: string,
): FailedBeforeClaimRunEvidence[] {
  const counts = new Map<string, number>()
  const rows = database
    .query<FailedBeforeClaimRunEvidenceRow, [string]>(
      `SELECT substr(started_at,1,10) day,job,count(*) count
         FROM run
        WHERE ${CURSORLESS_RUN_FAMILY_PREDICATE}
          AND agent='(pending)'
          AND status='failed'
          AND started_at>=?
        GROUP BY substr(started_at,1,10),job
        ORDER BY day,job`,
    )
    .all(from)
  for (const row of rows) {
    if (!Object.hasOwn(JOBS, row.job)) continue
    counts.set(row.day, (counts.get(row.day) ?? 0) + row.count)
  }
  return [...counts].map(([day, count]) => ({ day, count }))
}
