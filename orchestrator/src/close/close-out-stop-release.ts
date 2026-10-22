// concern: close-out
/** Releases a stopped conversation's tree only when it is a reader clone. Must not know the CLI. */

import { discardWorktreeAbsence } from '../cleanup/discard-worktree-absence.ts'
import { db } from '../database/db.ts'
import { isReadOnlyRepositoryJob } from '../jobs/jobs.ts'
import { closeOutRun } from './close-out.ts'

export type StoppedReaderCloneRelease = 'released' | 'kept' | 'not-applicable'

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

/** Release this conversation's tree only if it is a reader clone; otherwise do not touch it. */
export function releaseStoppedReaderClone(
  runId: string,
  extraPids: number[] = [],
): StoppedReaderCloneRelease {
  const rootId = conversationRoot(runId)
  const { job, worktree } = stoppedConversationTree(rootId)
  if (!worktree || !isReadOnlyRepositoryJob(job)) return 'not-applicable'
  if (recordedReaderCloneRelease(rootId)) return 'released'
  try {
    closeOutRun(rootId, { intent: 'terminal', extraPids })
  } catch {
    // Close-out may have recorded the release before throwing.
  }
  return recordedReaderCloneRelease(rootId) ? 'released' : 'kept'
}
