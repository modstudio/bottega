// concern: closed session sweep
/** Replays session release, expires machine liveness and claims, and retains its close-out record. */

import type { Database } from 'bun:sqlite'
import { releaseSessionClaims } from '../board/board-claim-service.ts'
import { expireSessionSeen, writableDb, writeTransaction } from '../database/db.ts'
import { KEEP_RUN_FILES_DAYS } from '../run/run-artifact-limits.ts'
import { releaseSessionResources } from '../session/session-close-out.ts'
import type { CleanupPresentation } from './cleanup.ts'
import { decideSessionCloseOutSweep } from './cleanup-sweep-session-close-out-decision.ts'

type CloseOutRow = {
  record_id: string
  session_id: string
  closed_at: string
  clean: number
  swept_at: string | null
  last_seen: string | null
}

type SweepAdapters = {
  release: (session: string) => Promise<void>
  releaseClaims: (session: string, now: number, database: Database) => number
}

const defaultAdapters: SweepAdapters = {
  release: async (session) => {
    await releaseSessionResources({ session })
  },
  releaseClaims: releaseSessionClaims,
}

async function sweepCloseOutRow(input: {
  row: CloseOutRow
  database: Database
  now: number
  adapters: SweepAdapters
  presentation: CleanupPresentation
}): Promise<boolean> {
  try {
    await input.adapters.release(input.row.session_id)
    input.adapters.releaseClaims(input.row.session_id, input.now, input.database)
    writeTransaction(() => {
      expireSessionSeen(input.row.session_id, input.database)
      input.database
        .query('UPDATE session_close_out SET swept_at=? WHERE record_id=? AND swept_at IS NULL')
        .run(new Date(input.now).toISOString(), input.row.record_id)
    }, input.database)
    input.presentation.log(`swept closed session ${input.row.session_id}`)
    return false
  } catch (cause) {
    input.presentation.error(
      `could not sweep closed session ${input.row.session_id}: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    return true
  }
}

export async function sweepSessionCloseOutRecords(input: {
  enabled: boolean
  dryRun: boolean
  presentation: CleanupPresentation
  database?: Database
  now?: number
  adapters?: SweepAdapters
}): Promise<boolean> {
  if (!input.enabled) return false
  const database = input.database ?? writableDb()
  const now = input.now ?? Date.now()
  const adapters = input.adapters ?? defaultAdapters
  const rows = database
    .query(
      `SELECT close_out.record_id,close_out.session_id,close_out.closed_at,close_out.clean,
              close_out.swept_at,seen.last_seen
         FROM session_close_out close_out
         LEFT JOIN session_seen seen ON seen.session_id=close_out.session_id
        ORDER BY close_out.session_id,close_out.closed_at DESC,close_out.record_id DESC`,
    )
    .all() as CloseOutRow[]
  const newest = new Set<string>()
  let failed = false
  for (const row of rows) {
    const isNewest = !newest.has(row.session_id)
    newest.add(row.session_id)
    const decision = decideSessionCloseOutSweep({
      newest: isNewest,
      clean: row.clean === 1,
      closedAt: Date.parse(row.closed_at),
      lastSeenAt: row.last_seen === null ? null : Date.parse(row.last_seen),
      sweptAt: row.swept_at === null ? null : Date.parse(row.swept_at),
    })
    if (decision.action === 'skip') continue
    if (input.dryRun) {
      input.presentation.log(`would sweep closed session ${row.session_id}`)
      continue
    }
    if (await sweepCloseOutRow({ row, database, now, adapters, presentation: input.presentation }))
      failed = true
  }
  if (!input.dryRun) {
    const cutoff = new Date(now - KEEP_RUN_FILES_DAYS * 86_400_000).toISOString()
    database
      .query('DELETE FROM session_close_out WHERE swept_at IS NOT NULL AND swept_at<?')
      .run(cutoff)
  }
  return failed
}
