// concern: closed session sweep
/** Replays session release, expires machine liveness and claims, and retains its close-out record. */

import type { Database } from 'bun:sqlite'
import { releaseSessionClaims } from '../board/board-claim-service.ts'
import { db, expireSessionSeen, writableDb, writeTransaction } from '../database/db.ts'
import { KEEP_RUN_FILES_DAYS } from '../run/run-artifact-limits.ts'
import {
  releaseSessionResources,
  type SessionCloseOutReport,
} from '../session/session-close-out.ts'
import {
  markSessionCloseOutSwept,
  newestSessionCloseOutRecords,
  pruneSessionCloseOutRecords,
  type SessionCloseOutRow,
  sessionCloseOutLastSeen,
} from '../session/session-close-out-store.ts'
import type { CleanupPresentation } from './cleanup.ts'
import { decideSessionCloseOutSweep } from './cleanup-sweep-session-close-out-decision.ts'

type SweepAdapters = {
  release: (session: string) => Promise<SessionCloseOutReport>
  releaseClaims: (session: string, now: number, database: Database) => number
}

const defaultAdapters: SweepAdapters = {
  release: async (session) => releaseSessionResources({ session }),
  releaseClaims: releaseSessionClaims,
}

class SessionResumedDuringSweep extends Error {}

function rowDecision(row: SessionCloseOutRow, lastSeen: string | null = row.last_seen) {
  return decideSessionCloseOutSweep({
    newest: true,
    clean: row.clean === 1,
    closedAt: Date.parse(row.closed_at),
    lastSeenAt: lastSeen === null ? null : Date.parse(lastSeen),
    sweptAt: row.swept_at === null ? null : Date.parse(row.swept_at),
  })
}

function reportUncleanReplay(
  session: string,
  report: SessionCloseOutReport,
  presentation: CleanupPresentation,
): void {
  for (const item of report.process)
    presentation.error(
      `closed session ${session} remains: ${item.item}: ${item.reason}; evidence: ${item.evidence}; remedy: ${item.remedy}`,
    )
  for (const item of report.errors)
    presentation.error(
      `closed session ${session} error: ${item.item}: ${item.detail}; retry: ${item.retry}`,
    )
}

async function sweepCloseOutRow(input: {
  row: SessionCloseOutRow
  database: Database
  now: number
  adapters: SweepAdapters
  presentation: CleanupPresentation
}): Promise<boolean> {
  try {
    const beforeRelease = rowDecision(
      input.row,
      sessionCloseOutLastSeen(input.row.session_id, input.database),
    )
    if (beforeRelease.action === 'skip') return false
    const report = await input.adapters.release(input.row.session_id)
    if (!report.verdict.clean) {
      reportUncleanReplay(input.row.session_id, report, input.presentation)
      return true
    }
    writeTransaction(() => {
      const lastSeen = sessionCloseOutLastSeen(input.row.session_id, input.database)
      if (rowDecision(input.row, lastSeen).action === 'skip') throw new SessionResumedDuringSweep()
      input.adapters.releaseClaims(input.row.session_id, input.now, input.database)
      expireSessionSeen(input.row.session_id, input.database)
      markSessionCloseOutSwept(
        input.row.record_id,
        new Date(input.now).toISOString(),
        input.database,
      )
    }, input.database)
    input.presentation.log(`swept closed session ${input.row.session_id}`)
    return false
  } catch (cause) {
    if (cause instanceof SessionResumedDuringSweep) return false
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
  const database = input.database ?? (input.dryRun ? db() : writableDb())
  const now = input.now ?? Date.now()
  const adapters = input.adapters ?? defaultAdapters
  const rows = newestSessionCloseOutRecords(database)
  let failed = false
  for (const row of rows) {
    const decision = rowDecision(row)
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
    pruneSessionCloseOutRecords(cutoff, database)
  }
  return failed
}
