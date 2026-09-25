// concern: run-authority
/**
 * Knows root ownership, adoption, and mutation audit. Must not know routing, transports, CLI adapters, worktrees, or reviews.
 */
import type { Database } from 'bun:sqlite'
import { db, nowIso, sessionId, writableDb } from '../database/db.ts'

const RUN_MUTATION_ACTIONS = [
  'adopt',
  'answer',
  'overturn',
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
  runId: number
  rootId: number
  owner: string | null
  actor: string | null
}

export function runMutationAuthority(database: Database, runId: number): RootAuthority {
  const row = database
    .query(
      `SELECT requested.id run_id, root.id root_id, root.session_id owner
       FROM run requested
       JOIN run root ON root.id = COALESCE(requested.parent_run_id, requested.id)
      WHERE requested.id = ?`,
    )
    .get(runId) as { run_id: number; root_id: number; owner: string | null } | null
  if (!row) throw new Error(`no run ${runId}`)
  return {
    runId: row.run_id,
    rootId: row.root_id,
    owner: row.owner,
    actor: sessionId(),
  }
}

export function runMutationActor(runId: number): RootAuthority {
  return runMutationAuthority(db(), runId)
}

export function authorizeRunMutation(
  runId: number,
  action: RunMutationAction | 'receipt',
): RootAuthority {
  writableDb()
  const authority = runMutationActor(runId)
  if (authority.owner && authority.actor !== authority.owner) {
    throw new Error(
      `run ${runId} is owned by session ${authority.owner}; ` +
        `current session ${authority.actor ?? 'no session identity is present'} cannot ${action} it`,
    )
  }
  return authority
}

export function auditRunMutation(
  authority: RootAuthority,
  action: RunMutationAction,
  reason: string | null = null,
  database: Database = db(),
): void {
  database
    .query(
      `INSERT INTO run_mutation_audit (run_id, root_id, action, actor_session, at, reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(authority.runId, authority.rootId, action, authority.actor, nowIso(), reason)
}

const ADOPTING_ACTIONS = [
  'answer',
  'overturn',
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
    throw new Error(`run ${authority.runId} is unowned; CLAUDE_CODE_SESSION_ID is not set`)
  }
  const claimed = database
    .query('UPDATE run SET session_id=? WHERE id=? AND session_id IS NULL')
    .run(authority.actor, authority.rootId)
  if (claimed.changes !== 1) {
    const owner = database.query('SELECT session_id FROM run WHERE id=?').get(authority.rootId) as {
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
