// concern: run-authority
/**
 * Knows root ownership, adoption, and mutation audit. Must not know routing, transports, CLI adapters, worktrees, or reviews.
 */
import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { callerIdentityRefusal } from '../caller-classification.ts'
import { callerIdentity, db, nowIso, sessionId, writableDb } from '../database/db.ts'
import {
  joinMutationReason,
  RUN_MUTATION_WINDOW_MS,
  reauthorizeAdoptedMutation,
  runMutationOwnerDecision,
} from './run-mutation-owner.ts'

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
  now: number
  windowMs: number
}

export function runMutationAuthority(database: Database, runId: string): RootAuthority {
  const row = database
    .query(
      `SELECT requested.record_id run_record_id, root.record_id root_id, root.session_id owner, seen.last_seen,
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
    last_seen: string | null
    chain_last_activity: string
  } | null
  if (!row) throw new Error(`no run ${runId}`)
  return {
    runId: row.run_record_id,
    rootId: row.root_id,
    owner: row.owner,
    actor: sessionId(),
    ownerLastSeenAt: row.last_seen === null ? null : Date.parse(row.last_seen),
    chainLastActivityAt: Date.parse(row.chain_last_activity),
    now: Date.now(),
    windowMs: RUN_MUTATION_WINDOW_MS,
  }
}

function adoptedMutationReason(authority: RootAuthority): string | null {
  if (runMutationOwnerDecision(authority) !== 'adopt') return null
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
      `current session ${authority.actor} cannot ${action} it (owner active within the window)`,
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
  const claimed = database
    .query('UPDATE run SET session_id=? WHERE record_id=? AND session_id IS NULL')
    .run(authority.actor, authority.rootId)
  if (claimed.changes !== 1) {
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
  auditRunMutation(adopted, 'adopt', `before ${action}`, database)
  return adopted
}
