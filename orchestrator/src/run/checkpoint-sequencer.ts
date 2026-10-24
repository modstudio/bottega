// concern: checkpoint-sequencer
/**
 * Decides whether a checkpoint may commit, from the checkout's own sequencer
 * state. `shared/git.ts:inspectCheckout` already answers "is a sequencer
 * operation in progress" by reading git status's own diagnosis; this file only
 * maps that answer onto the checkpoint's choice, so the two can never disagree
 * about what git is doing. Must not know the database, run state, worktrees, or
 * how the state is read.
 */

import type { SequenceKind, SequenceState } from '../../../shared/git.ts'

export type CheckpointSequenceDecision =
  | { action: 'commit' }
  | { action: 'skip'; operation: SequenceKind }
  | { action: 'refuse' }

/**
 * A stopped rebase, merge, cherry-pick, revert, `git am` or bisect leaves the
 * tree half-applied, so committing captures that state on the run branch; the
 * kind is carried out so the worker learns which operation to finish. A state
 * git cannot report refuses instead, because a tree whose state nobody could
 * read may be half-applied too.
 *
 * `none` commits, and so does `residue` — a leftover pseudo-ref over a clean
 * tree. `projects.ts` reads residue the same way for the same reason: refusing
 * it would block an otherwise clean tree. `inspectSequence` does not produce
 * `residue` today.
 */
export function decideCheckpointCommit(sequence: SequenceState): CheckpointSequenceDecision {
  if (sequence.status === 'in-progress') return { action: 'skip', operation: sequence.kind }
  if (sequence.status === 'indeterminate') return { action: 'refuse' }
  return { action: 'commit' }
}
