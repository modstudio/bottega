// concern: run-authority
/**
 * Knows root ownership, adoption, and mutation audit. Must not know routing, transports, CLI adapters, worktrees, or reviews.
 */
import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { callerIdentityRefusal } from '../caller-classification.ts'
import {
  callerIdentity,
  db,
  nowIso,
  sessionId,
  writableDb,
  writeTransaction,
} from '../database/db.ts'
import { filedIssueLoopRun } from '../issue/issue-queue.ts'
import type { ProcessIdentity } from '../resources/session-process-anchoring.ts'
import {
  joinMutationReason,
  RUN_MUTATION_WINDOW_MS,
  reauthorizeAdoptedMutation,
  runMutationOwnerDecision,
} from './run-mutation-owner.ts'
import { sessionLivenessEvidence } from './session-liveness-adapter.ts'

const RUN_MUTATION_ACTIONS = [
  'adopt',
  'answer',
  'overturn',
  'file',
  'tell',
  'relay',
  'stop',
  'abandon',
  'discard',
  'sweep',
  'reap',
  'void',
  'unvoid',
  'score',
  'rescore',
  'retry',
  'continue',
  'reclassify',
  'canon-eval',
] as const
export type RunMutationAction = (typeof RUN_MUTATION_ACTIONS)[number]
export type RootAuthority = {
  runId: string
  rootId: string
  owner: string | null
  actor: string | null
  ownerLastSeenAt: number | null
  chainLastActivityAt: number
  coordinatorRun: boolean
  now: number
  windowMs: number
  ownerProcess: 'dead' | 'live' | 'unknown'
  ownerAnchor: ProcessIdentity | null
}

/** Build the authority shape used only to record an ownership transfer already authorized by its caller. */
function auditOnlyRootAuthority(rootId: string, actor: string): RootAuthority {
  return {
    runId: rootId,
    rootId,
    owner: actor,
    actor,
    ownerLastSeenAt: null,
    chainLastActivityAt: 0,
    coordinatorRun: false,
    now: 0,
    windowMs: 0,
    ownerProcess: 'unknown',
    ownerAnchor: null,
  }
}

export function runMutationAuthority(database: Database, runId: string): RootAuthority {
  const row = database
    .query(
      `SELECT requested.record_id run_record_id, root.record_id root_id, root.session_id owner,
              root.job, root.label, seen.last_seen,
              (SELECT COALESCE(turn.last_event_at,turn.started_at)
                 FROM run turn
                WHERE turn.record_id=root.record_id OR turn.parent_run_record_id=root.record_id
                ORDER BY turn.turn DESC,turn.number DESC LIMIT 1) chain_last_activity
       FROM run requested
       JOIN run root ON root.record_id = COALESCE(requested.parent_run_record_id, requested.record_id)
       LEFT JOIN session_seen seen ON seen.session_id=root.session_id
      WHERE requested.record_id = ?`,
    )
    .get(runId) as {
    run_record_id: string
    root_id: string
    owner: string | null
    job: string
    label: string | null
    last_seen: string | null
    chain_last_activity: string
  } | null
  if (!row) throw new Error(`no run ${runId}`)
  const actor = sessionId()
  const liveness = row.owner && row.owner !== actor
    ? sessionLivenessEvidence(database, row.owner, actor)
    : { ownerProcess: 'unknown' as const, anchor: null }
  return {
    runId: row.run_record_id,
    rootId: row.root_id,
    owner: row.owner,
    actor,
    ownerLastSeenAt: row.last_seen === null ? null : Date.parse(row.last_seen),
    chainLastActivityAt: Date.parse(row.chain_last_activity),
    coordinatorRun: filedIssueLoopRun({ id: row.root_id, job: row.job, label: row.label }) !== null,
    now: Date.now(),
    windowMs: RUN_MUTATION_WINDOW_MS,
    ownerProcess: liveness.ownerProcess,
    ownerAnchor: liveness.anchor,
  }
}

function adoptedMutationReason(authority: RootAuthority): string | null {
  if (runMutationOwnerDecision(authority) !== 'adopt') return null
  if (authority.ownerProcess === 'dead' && authority.ownerAnchor)
    return `adopted from dead owner ${authority.owner} (anchor pid ${authority.ownerAnchor.pid} gone) by ${authority.actor}`
  return `adopted from gone owner ${authority.owner} by ${authority.actor}`
}

export function runMutationActor(runId: string): RootAuthority {
  return runMutationAuthority(db(), runId)
}

function refuseRunMutation(authority: RootAuthority, action: RunMutationAction | 'receipt'): never {
  if (!authority.actor) {
    throw new Error(
      `run ${authority.runId} is owned by session ${authority.owner}; ${callerIdentityRefusal(callerIdentity(), action)}`,
    )
  }
  throw new Error(
    `run ${authority.runId} is owned by session ${authority.owner}; ` +
      `current session ${authority.actor} cannot ${action} it (owner active within the window; ` +
      `owner process ${authority.ownerProcess}, anchor ${authority.ownerAnchor ? `pid ${authority.ownerAnchor.pid} started ${authority.ownerAnchor.startTime}` : 'unknown'}, ` +
      `last_seen ${authority.ownerLastSeenAt === null ? 'unknown' : new Date(authority.ownerLastSeenAt).toISOString()}); ` +
      `run bottega session adopt ${authority.owner} --reason "<why>"`,
  )
}

export function authorizeRunMutation(
  runId: string,
  action: RunMutationAction | 'receipt',
): RootAuthority {
  writableDb()
  const authority = runMutationActor(runId)
  if (runMutationOwnerDecision(authority) === 'refuse') refuseRunMutation(authority, action)
  return authority
}

export function reauthorizeRunMutation(
  authority: RootAuthority,
  action: RunMutationAction | 'receipt',
  database: Database = db(),
): RootAuthority {
  return reauthorizeAdoptedMutation(
    authority,
    () => runMutationAuthority(database, authority.runId),
    (current) => refuseRunMutation(current, action),
  )
}

export function auditRunMutation(
  authority: RootAuthority,
  action: RunMutationAction,
  reason: string | null = null,
  database: Database = db(),
  turnId: string | null = null,
): void {
  database
    .query(
      `INSERT INTO run_mutation_audit (record_id, run_record_id, root_run_record_id, action, actor_session, at, reason, turn_run_record_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newRecordId(),
      authority.runId,
      authority.rootId,
      action,
      authority.actor,
      nowIso(),
      joinMutationReason(reason, adoptedMutationReason(authority)),
      turnId,
    )
}

/** Transfer a root and only the turns still held by its expected owner, then record the adoption. */
export function transferRunMutationOwnership(
  rootId: string,
  expectedOwner: string | null,
  newOwner: string,
  reason: string,
  database: Database = db(),
): boolean {
  return writeTransaction(() => {
    const claimed = database
      .query('UPDATE run SET session_id=? WHERE record_id=? AND session_id IS ?')
      .run(newOwner, rootId, expectedOwner)
    if (claimed.changes !== 1) return false
    database
      .query('UPDATE run SET session_id=? WHERE parent_run_record_id=? AND session_id IS ?')
      .run(newOwner, rootId, expectedOwner)
    auditRunMutation(auditOnlyRootAuthority(rootId, newOwner), 'adopt', reason, database)
    return true
  }, database)
}

const ADOPTING_ACTIONS = [
  'answer',
  'overturn',
  'file',
  'tell',
  'relay',
  'stop',
  'abandon',
  'discard',
  'void',
  'unvoid',
  'continue',
  'score',
  'retry',
  'receipt',
] as const
type AdoptingAction = (typeof ADOPTING_ACTIONS)[number]

/** Atomically claim an unowned chain before an authoritative mutation. */
export function adoptRunMutation(
  authority: RootAuthority,
  action: AdoptingAction,
  database: Database = db(),
): RootAuthority {
  if (authority.owner) return authority
  if (!authority.actor) {
    throw new Error(
      `run ${authority.runId} is unowned; ${callerIdentityRefusal(callerIdentity(), action)}`,
    )
  }
  const claimed = transferRunMutationOwnership(
    authority.rootId,
    null,
    authority.actor,
    `before ${action}`,
    database,
  )
  if (!claimed) {
    const owner = database
      .query('SELECT session_id FROM run WHERE record_id=?')
      .get(authority.rootId) as {
      session_id: string | null
    } | null
    if (!owner?.session_id || owner.session_id !== authority.actor) {
      throw new Error(
        `run ${authority.runId} was adopted by session ${owner?.session_id ?? 'unknown'} ` +
          `before current session ${authority.actor} could ${action} it`,
      )
    }
    return { ...authority, owner: owner.session_id }
  }
  const adopted = { ...authority, owner: authority.actor }
  return adopted
}
