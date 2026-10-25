// concern: session adoption
/** Transfers every run chain owned by one session to an identified successor. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { callerIdentityRefusal } from '../caller-classification.ts'
import {
  callerIdentity,
  db,
  SESSION_LIVE_MS,
  sessionId,
  writableDb,
  writeTransaction,
} from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import { transferRunMutationOwnership } from '../run/run-authority.ts'
import { enqueueRunRecord } from '../run/run-outbox.ts'
import {
  formatSessionLivenessEvidence,
  type SessionLivenessEvidence,
} from '../run/session-liveness.ts'
import {
  type SessionProcessProbe,
  sessionLivenessEvidence,
} from '../run/session-liveness-adapter.ts'

type SessionAdoptedRun = {
  number: number
  recordId: string
  job: string
  key: string | null
  turns: number
}

type SessionAdoptionFailure = SessionAdoptedRun & {
  reason: string
  currentOwner: string | null
}
type PendingSessionAdoptionFailure = Omit<SessionAdoptionFailure, 'currentOwner'>

export type SessionAdoptionReport = {
  fromSession: string
  toSession: string
  consent: SessionAdoptionConsent
  runs: SessionAdoptedRun[]
  notMoved: SessionAdoptionFailure[]
  totalRuns: number
  totalTurns: number
}

type SessionAdoptionConsent = 'standard' | 'resume-handoff' | 'cut-off'

type Root = {
  record_id: string
  number: number
  job: string
  launch_key: string | null
}

export type AdoptionOptions = {
  consent?: SessionAdoptionConsent
  database?: Database
  now?: number
  probe?: SessionProcessProbe
  actor?: string | null
  machine?: string
  transfer?: typeof transferRunMutationOwnership
}

function ownedRoots(database: Database, session: string): Root[] {
  return database
    .query<Root, [string]>(
      `SELECT record_id,number,job,launch_key FROM run
       WHERE parent_run_record_id IS NULL AND session_id=? ORDER BY number`,
    )
    .all(session)
}

function adoptedRun(database: Database, root: Root, owner: string): SessionAdoptedRun {
  const turns = (
    database
      .query<{ count: number }, [string, string, string]>(
        `SELECT COUNT(*) count FROM run
         WHERE (record_id=? OR parent_run_record_id=?) AND session_id=?`,
      )
      .get(root.record_id, root.record_id, owner) as { count: number }
  ).count
  return {
    number: root.number,
    recordId: root.record_id,
    job: root.job,
    key: root.launch_key,
    turns,
  }
}

function transferRoot(input: {
  database: Database
  root: Root
  target: string
  actor: string
  reason: string
  consent: SessionAdoptionConsent
  options: AdoptionOptions
}): { moved?: SessionAdoptedRun; failed?: PendingSessionAdoptionFailure } {
  const { database, root, target, actor, reason, consent, options } = input
  const run = adoptedRun(database, root, target)
  const terminal = database
    .query<{ record_id: string; finished_at: string }, [string, string]>(
      `SELECT record_id,COALESCE(last_event_at,started_at) finished_at FROM run
       WHERE (record_id=? OR parent_run_record_id=?)
         AND status IN ('ok','failed','stale','stopped','asking')
       ORDER BY turn,number`,
    )
    .all(root.record_id, root.record_id)
  const machine = terminal.length ? (options.machine ?? machineId()) : null
  const transfer = options.transfer ?? transferRunMutationOwnership
  try {
    const transferred = writeTransaction(() => {
      if (!transfer(root.record_id, target, actor, `consent ${consent}: ${reason}`, database))
        return false
      for (const member of terminal)
        enqueueRunRecord(database, member.record_id, machine!, member.finished_at)
      return true
    }, database)
    return transferred
      ? { moved: run }
      : { failed: { ...run, reason: 'ownership changed before transfer' } }
  } catch (error) {
    return {
      failed: { ...run, reason: error instanceof Error ? error.message : String(error) },
    }
  }
}

function remainingFailures(
  database: Database,
  target: string,
  failures: PendingSessionAdoptionFailure[],
): PendingSessionAdoptionFailure[] {
  const known = new Set(failures.map(({ recordId }) => recordId))
  return ownedRoots(database, target)
    .filter(({ record_id }) => !known.has(record_id))
    .map((root) => ({
      ...adoptedRun(database, root, target),
      reason: 'still owned by target after adoption',
    }))
}

function currentFailureOwners(
  database: Database,
  failures: PendingSessionAdoptionFailure[],
): SessionAdoptionFailure[] {
  return failures.map((failure) => ({
    ...failure,
    currentOwner:
      database
        .query<{ session_id: string | null }, [string]>(
          'SELECT session_id FROM run WHERE record_id=?',
        )
        .get(failure.recordId)?.session_id ?? null,
  }))
}

function assertAdoptionConsent(
  target: string,
  evidence: SessionLivenessEvidence,
  consent: SessionAdoptionConsent,
): void {
  const closeOut = `the owner runs ${PLATFORM_SLUG} session close-out --session ${target}`
  if (evidence.ownerProcess === 'live')
    throw new Error(
      `session ${target} is live (${formatSessionLivenessEvidence(evidence)}); ${closeOut} before adoption`,
    )
  if (evidence.ownerProcess !== 'unknown' || consent === 'resume-handoff') return
  if (evidence.unknownCause === 'recently-seen' && consent === 'cut-off') return
  if (evidence.unknownCause === 'recently-seen') {
    const opensAt = new Date(evidence.ownerLastSeenAt! + SESSION_LIVE_MS).toISOString()
    throw new Error(
      `session ${target} process is unknown (${formatSessionLivenessEvidence(evidence)}); ${closeOut}, ` +
        `wait until ${opensAt}, or use --cut-off now when the session was cut off`,
    )
  }
  throw new Error(
    `session ${target} liveness could not be established (${formatSessionLivenessEvidence(evidence)}); ${closeOut} before adoption`,
  )
}

export function adoptSessionRuns(
  target: string,
  reason: string,
  options: AdoptionOptions = {},
): SessionAdoptionReport {
  if (!reason.trim()) throw new Error('session adoption reason must not be empty')
  const database = options.database ?? db()
  if (!options.database) writableDb()
  const actor = options.actor === undefined ? sessionId(database) : options.actor
  if (!actor)
    throw new Error(
      `session adoption requires an identity; ${callerIdentityRefusal(callerIdentity(database), 'adopt another session')}`,
    )
  if (target === actor) throw new Error(`session ${target} cannot adopt its own runs`)
  const now = options.now ?? Date.now()
  const evidence = sessionLivenessEvidence(database, target, actor, {
    now,
    probe: options.probe,
  })
  const consent = options.consent ?? 'standard'
  assertAdoptionConsent(target, evidence, consent)
  const moved: SessionAdoptedRun[] = []
  const notMoved: PendingSessionAdoptionFailure[] = []
  for (const root of ownedRoots(database, target)) {
    const outcome = transferRoot({ database, root, target, actor, reason, consent, options })
    if (outcome.moved) moved.push(outcome.moved)
    if (outcome.failed) notMoved.push(outcome.failed)
  }
  notMoved.push(...remainingFailures(database, target, notMoved))
  return {
    fromSession: target,
    toSession: actor,
    consent,
    runs: moved,
    notMoved: currentFailureOwners(database, notMoved),
    totalRuns: moved.length,
    totalTurns: moved.reduce((sum, run) => sum + run.turns, 0),
  }
}

export function formatSessionAdoption(report: SessionAdoptionReport): string {
  if (!report.runs.length && !report.notMoved.length)
    return `session ${report.fromSession} owns no runs; consent: ${report.consent}`
  return [
    ...report.runs.map(
      (run) =>
        `run ${run.number} ${run.recordId} ${run.job} ${run.key ?? '-'}: ${run.turns} turn(s)`,
    ),
    ...report.notMoved.map(
      (run) =>
        `not moved run ${run.number} ${run.recordId} ${run.job} ${run.key ?? '-'}: ${run.turns} turn(s) (${run.reason})`,
    ),
    `total: ${report.totalRuns} run(s), ${report.totalTurns} turn(s) moved; ${report.notMoved.length} run(s) remain; consent: ${report.consent}`,
  ].join('\n')
}
