// concern: session adoption
/** Transfers every run chain owned by one session to an identified successor. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { callerIdentityRefusal } from '../caller-classification.ts'
import { callerIdentity, db, sessionId, writableDb, writeTransaction } from '../database/db.ts'
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

type SessionAdoptionFailure = SessionAdoptedRun & { reason: string }

export type SessionAdoptionReport = {
  fromSession: string
  toSession: string
  runs: SessionAdoptedRun[]
  notMoved: SessionAdoptionFailure[]
  totalRuns: number
  totalTurns: number
}

type SessionAdoptionConsent = 'standard' | 'resume-handoff'

type Root = {
  record_id: string
  number: number
  job: string
  launch_key: string | null
}

type AdoptionOptions = {
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
  options: AdoptionOptions
}): { moved?: SessionAdoptedRun; failed?: SessionAdoptionFailure } {
  const { database, root, target, actor, reason, options } = input
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
      if (!transfer(root.record_id, target, actor, reason, database)) return false
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
  failures: SessionAdoptionFailure[],
): SessionAdoptionFailure[] {
  const known = new Set(failures.map(({ recordId }) => recordId))
  return ownedRoots(database, target)
    .filter(({ record_id }) => !known.has(record_id))
    .map((root) => ({
      ...adoptedRun(database, root, target),
      reason: 'still owned by target after adoption',
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
  if (consent === 'standard' && evidence.ownerProcess === 'unknown')
    throw new Error(
      `session ${target} process is unknown (${formatSessionLivenessEvidence(evidence)}); ${closeOut}, ` +
        `or retry the run mutation after its ownership window expires`,
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
  assertAdoptionConsent(target, evidence, options.consent ?? 'standard')
  const moved: SessionAdoptedRun[] = []
  const notMoved: SessionAdoptionFailure[] = []
  for (const root of ownedRoots(database, target)) {
    const outcome = transferRoot({ database, root, target, actor, reason, options })
    if (outcome.moved) moved.push(outcome.moved)
    if (outcome.failed) notMoved.push(outcome.failed)
  }
  notMoved.push(...remainingFailures(database, target, notMoved))
  return {
    fromSession: target,
    toSession: actor,
    runs: moved,
    notMoved,
    totalRuns: moved.length,
    totalTurns: moved.reduce((sum, run) => sum + run.turns, 0),
  }
}

export function formatSessionAdoption(report: SessionAdoptionReport): string {
  if (!report.runs.length && !report.notMoved.length)
    return `session ${report.fromSession} owns no runs`
  return [
    ...report.runs.map(
      (run) =>
        `run ${run.number} ${run.recordId} ${run.job} ${run.key ?? '-'}: ${run.turns} turn(s)`,
    ),
    ...report.notMoved.map(
      (run) =>
        `not moved run ${run.number} ${run.recordId} ${run.job} ${run.key ?? '-'}: ${run.turns} turn(s) (${run.reason})`,
    ),
    `total: ${report.totalRuns} run(s), ${report.totalTurns} turn(s) moved; ${report.notMoved.length} run(s) remain`,
  ].join('\n')
}
