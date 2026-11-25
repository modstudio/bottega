// concern: closed session sweep
/** Replays session release, expires machine liveness and claims, and retains its close-out record. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { releaseSessionClaims } from '../board/board-claim-service.ts'
import { boardModeDecision } from '../board/board-mode.ts'
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
import {
  decideHostedReleaseRow,
  decideSessionCloseOutSweep,
  type HostedReleaseCircuitCause,
  hostedReleaseFailure,
  hostedReleaseTripsCircuit,
} from './cleanup-sweep-session-close-out-decision.ts'
import { releaseHostedClaims } from './cleanup-sweep-session-close-out-hosted.ts'

type SweepAdapters = {
  release: (session: string) => Promise<SessionCloseOutReport>
  releaseClaims: (session: string, now: number, database: Database) => number
  releaseHostedClaims: (session: string, database: Database) => Promise<number>
}

const defaultAdapters: SweepAdapters = {
  release: async (session) => releaseSessionResources({ session }),
  releaseClaims: releaseSessionClaims,
  releaseHostedClaims,
}

class SessionResumedDuringSweep extends Error {}
class SessionCloseOutAlreadySwept extends Error {}

type HostedReleaseState = { circuitCause: HostedReleaseCircuitCause | null }

function rowDecision(row: SessionCloseOutRow, lastSeen: string | null = row.last_seen) {
  return decideSessionCloseOutSweep({
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

function reportDryRun(
  row: SessionCloseOutRow,
  hostedReleaseEnabled: boolean,
  presentation: CleanupPresentation,
): void {
  presentation.log(`would sweep closed session ${row.session_id}`)
  if (hostedReleaseEnabled)
    presentation.log(`would release hosted board claims of closed session ${row.session_id}`)
}

async function releaseHostedClaimsForRow(input: {
  row: SessionCloseOutRow
  database: Database
  adapters: SweepAdapters
  presentation: CleanupPresentation
  enabled: boolean
  state: HostedReleaseState
}): Promise<'proceed' | 'stamp-final' | 'defer'> {
  const pending = decideHostedReleaseRow({
    session: input.row.session_id,
    enabled: input.enabled,
    circuitCause: input.state.circuitCause,
    attempt: { outcome: 'pending' },
    platformSlug: PLATFORM_SLUG,
  })
  if (pending.disposition === 'defer') {
    input.presentation.error(pending.message!)
    return 'defer'
  }
  if (!input.enabled) return 'proceed'
  try {
    const released = await input.adapters.releaseHostedClaims(input.row.session_id, input.database)
    if (released > 0)
      input.presentation.log(
        `released ${released} hosted board claims of closed session ${input.row.session_id}`,
      )
    return 'proceed'
  } catch (cause) {
    const decision = decideHostedReleaseRow({
      session: input.row.session_id,
      enabled: true,
      circuitCause: null,
      attempt: {
        outcome: 'failed',
        failure: hostedReleaseFailure(cause),
        message: cause instanceof Error ? cause.message : String(cause),
        tripCircuit: hostedReleaseTripsCircuit(cause),
      },
      platformSlug: PLATFORM_SLUG,
    })
    input.state.circuitCause = decision.circuitCause
    input.presentation.error(decision.message!)
    return decision.disposition
  }
}

async function sweepCloseOutRow(input: {
  row: SessionCloseOutRow
  database: Database
  now: number
  adapters: SweepAdapters
  presentation: CleanupPresentation
  releaseLocalClaims: boolean
  hostedReleaseEnabled: boolean
  hostedReleaseState: HostedReleaseState
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
    if (input.hostedReleaseEnabled) {
      const beforeHostedRelease = rowDecision(
        input.row,
        sessionCloseOutLastSeen(input.row.session_id, input.database),
      )
      if (beforeHostedRelease.action === 'skip') return false
    }
    const hostedDisposition = await releaseHostedClaimsForRow({
      row: input.row,
      database: input.database,
      adapters: input.adapters,
      presentation: input.presentation,
      enabled: input.hostedReleaseEnabled,
      state: input.hostedReleaseState,
    })
    if (hostedDisposition === 'defer') return true
    writeTransaction(() => {
      const lastSeen = sessionCloseOutLastSeen(input.row.session_id, input.database)
      if (rowDecision(input.row, lastSeen).action === 'skip') throw new SessionResumedDuringSweep()
      if (input.releaseLocalClaims)
        input.adapters.releaseClaims(input.row.session_id, input.now, input.database)
      expireSessionSeen(input.row.session_id, input.database)
      const marked = markSessionCloseOutSwept(
        input.row.record_id,
        new Date(input.now).toISOString(),
        input.database,
      )
      if (marked === 0) throw new SessionCloseOutAlreadySwept()
    }, input.database)
    input.presentation.log(`swept closed session ${input.row.session_id}`)
    return false
  } catch (cause) {
    if (cause instanceof SessionResumedDuringSweep) return false
    if (cause instanceof SessionCloseOutAlreadySwept) {
      input.presentation.log(`closed session ${input.row.session_id} was already swept`)
      return false
    }
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
  adapters?: Partial<SweepAdapters>
}): Promise<boolean> {
  if (!input.enabled) return false
  const database = input.database ?? (input.dryRun ? db() : writableDb())
  const now = input.now ?? Date.now()
  const adapters = { ...defaultAdapters, ...input.adapters }
  const boardDecision = boardModeDecision('shared', process.env, database)
  if (boardDecision.mode === 'refused') input.presentation.error(boardDecision.reason)
  const releaseLocalClaims = boardDecision.mode === 'local'
  const hostedReleaseEnabled = boardDecision.mode === 'hosted'
  const hostedReleaseState: HostedReleaseState = { circuitCause: null }
  const rows = newestSessionCloseOutRecords(database)
  let failed = false
  for (const row of rows) {
    const decision = rowDecision(row)
    if (decision.action === 'skip') continue
    if (boardDecision.mode === 'refused') {
      input.presentation.error(
        `deferred closed session ${row.session_id}: hosted board claims cannot be released while ${boardDecision.reason}`,
      )
      failed = true
      continue
    }
    if (input.dryRun) {
      reportDryRun(row, hostedReleaseEnabled, input.presentation)
      continue
    }
    if (
      await sweepCloseOutRow({
        row,
        database,
        now,
        adapters,
        presentation: input.presentation,
        releaseLocalClaims,
        hostedReleaseEnabled,
        hostedReleaseState,
      })
    )
      failed = true
  }
  if (!input.dryRun) {
    const cutoff = new Date(now - KEEP_RUN_FILES_DAYS * 86_400_000).toISOString()
    pruneSessionCloseOutRecords(cutoff, database)
  }
  return failed
}
