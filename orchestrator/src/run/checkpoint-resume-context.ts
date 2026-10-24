// concern: checkpoint-resume-context
/** Renders checkpoint provenance without deciding which commit the resumed tree exposes. */

import type { SequenceKind } from '../../../shared/git.ts'

export type CheckpointResumeValues = {
  startCommit: string | null
  branch: string | null
  checkpoint: {
    commit_sha: string
    checkpoint_no: number
    task_pointer: string | null
  } | null
  recentLog: string
  /** The git operation the resumed worktree is partway through, if any. */
  operation: SequenceKind | null
}

export function renderCheckpointResumeContext(input: CheckpointResumeValues): string | null {
  const operation = input.operation
    ? `A ${input.operation} is in progress in this worktree; finish or abort it before you commit.`
    : null
  // A worktree mid-operation is a tree state to resume from even when no
  // checkpoint was taken, because the final checkpoint skipped it.
  if (!input.checkpoint) return operation ? `CHECKPOINT RESUME\n${operation}` : null
  const checkpointAtStart = input.checkpoint.commit_sha === input.startCommit
  return [
    'CHECKPOINT RESUME',
    checkpointAtStart
      ? `Resume at ${input.startCommit} on ${input.branch} (checkpoint #${input.checkpoint.checkpoint_no}).`
      : `Resume at ${input.startCommit} on ${input.branch}.`,
    operation,
    checkpointAtStart
      ? null
      : `Latest harness checkpoint #${input.checkpoint.checkpoint_no} at ${input.checkpoint.commit_sha} is earlier than the start commit and is provenance, not the tree state.`,
    input.checkpoint.task_pointer ? `Last completed item: ${input.checkpoint.task_pointer}` : null,
    input.recentLog ? `Recent branch history:\n${input.recentLog}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}
