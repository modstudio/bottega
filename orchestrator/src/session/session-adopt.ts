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

export type SessionAdoptionReport = {
  fromSession: string
  toSession: string
  runs: SessionAdoptedRun[]
  totalRuns: number
  totalTurns: number
}

export type SessionAdoptionConsent = 'standard' | 'resume-handoff'

type Root = {
  record_id: string
  number: number
  job: string
  launch_key: string | null
}

function assertAdoptionConsent(
  target: string,
  evidence: SessionLivenessEvidence,
  consent: SessionAdoptionConsent,
  now: number,
): void {
  const closeOut = `the owner runs ${PLATFORM_SLUG} session close-out --session ${target}`
  if (evidence.ownerProcess === 'live')
    throw new Error(
      `session ${target} is live (${formatSessionLivenessEvidence(evidence)}); ${closeOut} before adoption`,
    )
  if (
    consent === 'standard' &&
    evidence.ownerProcess === 'unknown' &&
    evidence.ownerLastSeenAt !== null &&
    evidence.ownerLastSeenAt >= now - SESSION_LIVE_MS
  )
    throw new Error(
      `session ${target} process is unknown (${formatSessionLivenessEvidence(evidence)}); ${closeOut}, ` +
        `or wait until last_seen is older than the session live window`,
    )
}

export function adoptSessionRuns(
  target: string,
  reason: string,
  options: {
    consent?: SessionAdoptionConsent
    database?: Database
    now?: number
    probe?: SessionProcessProbe
    actor?: string | null
    machine?: string
  } = {},
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
  assertAdoptionConsent(target, evidence, options.consent ?? 'standard', now)
  const roots = database
    .query<Root, [string]>(
      `SELECT record_id,number,job,launch_key FROM run
       WHERE parent_run_record_id IS NULL AND session_id=? ORDER BY number`,
    )
    .all(target)
  const moved: SessionAdoptedRun[] = []
  for (const root of roots) {
    const turns = (
      database
        .query<{ count: number }, [string, string, string]>(
          `SELECT COUNT(*) count FROM run
           WHERE (record_id=? OR parent_run_record_id=?) AND session_id=?`,
        )
        .get(root.record_id, root.record_id, target) as { count: number }
    ).count
    const terminal = database
      .query<{ record_id: string; finished_at: string }, [string, string]>(
        `SELECT record_id,COALESCE(last_event_at,started_at) finished_at FROM run
         WHERE (record_id=? OR parent_run_record_id=?)
           AND status IN ('ok','failed','stale','stopped','asking')
         ORDER BY turn,number`,
      )
      .all(root.record_id, root.record_id)
    const machine = terminal.length ? (options.machine ?? machineId()) : null
    const transferred = writeTransaction(() => {
      if (!transferRunMutationOwnership(root.record_id, target, actor, reason, database))
        return false
      for (const member of terminal)
        enqueueRunRecord(database, member.record_id, machine!, member.finished_at)
      return true
    }, database)
    if (!transferred) continue
    moved.push({
      number: root.number,
      recordId: root.record_id,
      job: root.job,
      key: root.launch_key,
      turns,
    })
  }
  return {
    fromSession: target,
    toSession: actor,
    runs: moved,
    totalRuns: moved.length,
    totalTurns: moved.reduce((sum, run) => sum + run.turns, 0),
  }
}

export function formatSessionAdoption(report: SessionAdoptionReport): string {
  if (!report.runs.length) return `session ${report.fromSession} owns no runs`
  return [
    ...report.runs.map(
      (run) =>
        `run ${run.number} ${run.recordId} ${run.job} ${run.key ?? '-'}: ${run.turns} turn(s)`,
    ),
    `total: ${report.totalRuns} run(s), ${report.totalTurns} turn(s)`,
  ].join('\n')
}
