// concern: close-out
/** Releases a stopped conversation's tree only when it is a reader clone. Must not know the CLI. */

import { existsSync } from 'node:fs'
import { discardWorktreeAbsence } from '../cleanup/discard-worktree-absence.ts'
import { db } from '../database/db.ts'
import { isReadOnlyRepositoryJob } from '../jobs/jobs.ts'
import { closeOutRun } from './close-out.ts'

type StoppedReaderCloneReleaseOutcome =
  | 'released'
  | 'tree-released-with-unrecorded-row'
  | 'kept'
  | 'not-applicable'

export type StoppedReaderCloneRelease = {
  outcome: StoppedReaderCloneReleaseOutcome
  detail: string | null
}

function conversationRoot(runId: string): string {
  const row = db()
    .query<{ root_record_id: string }, [string]>(
      'SELECT COALESCE(parent_run_record_id,record_id) root_record_id FROM run WHERE record_id=?',
    )
    .get(runId)
  if (!row) throw new Error(`no run ${runId}`)
  return row.root_record_id
}

function recordedReaderCloneRelease(rootId: string): boolean {
  const recorded = db()
    .query<{ worktree: string | null; close_out_outcome: string | null }, [string]>(
      'SELECT worktree, close_out_outcome FROM run WHERE record_id=?',
    )
    .get(rootId)
  return Boolean(
    recorded &&
      !recorded.worktree &&
      discardWorktreeAbsence(recorded.close_out_outcome) === 'already-released',
  )
}

function stoppedConversationTree(rootId: string): { job: string; worktree: string | null } {
  const turns = db()
    .query<{ job: string; worktree: string | null }, [string, string]>(
      `SELECT job, worktree FROM run
       WHERE record_id=? OR parent_run_record_id=?
       ORDER BY turn DESC, number DESC`,
    )
    .all(rootId, rootId)
  return {
    job: turns[0]?.job ?? '',
    worktree: turns.find((turn) => turn.worktree)?.worktree ?? null,
  }
}

/** This stopped conversation's reader-clone tree, or null when it is not a reader clone. */
export function stoppedConversationIsReaderClone(
  runId: string,
): { rootId: string; worktree: string } | null {
  const rootId = conversationRoot(runId)
  const { job, worktree } = stoppedConversationTree(rootId)
  if (!worktree || !isReadOnlyRepositoryJob(job)) return null
  return { rootId, worktree }
}

/** Kept outcome when the close-out lease is still held. Does not acquire the lease. */
export function keptStoppedReaderClone(coordinatorPid: number | null): StoppedReaderCloneRelease {
  const pidClause =
    coordinatorPid != null
      ? `coordinator pid ${coordinatorPid} is still alive`
      : 'coordinator is not alive'
  return {
    outcome: 'kept',
    detail: `close-out lease still held; ${pidClause}`,
  }
}

/** Release this conversation's tree only if it is a reader clone; otherwise do not touch it. */
export function releaseStoppedReaderClone(
  runId: string,
  extraPids: number[] = [],
): StoppedReaderCloneRelease {
  const clone = stoppedConversationIsReaderClone(runId)
  if (!clone) {
    return { outcome: 'not-applicable', detail: null }
  }
  const { rootId, worktree } = clone
  if (recordedReaderCloneRelease(rootId)) return { outcome: 'released', detail: null }
  let detail: string | null = null
  try {
    detail = closeOutRun(rootId, { intent: 'terminal', extraPids }).detail
  } catch (error) {
    detail = String((error as Error).message ?? error)
    // Close-out may have recorded the release before throwing.
  }
  if (recordedReaderCloneRelease(rootId)) return { outcome: 'released', detail }
  return {
    outcome: existsSync(worktree) ? 'kept' : 'tree-released-with-unrecorded-row',
    detail,
  }
}
