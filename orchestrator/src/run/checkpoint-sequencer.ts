// concern: checkpoint-sequencer
/**
 * Decides whether git is partway through a sequencer operation, because
 * committing then captures a half-applied tree on the run branch. Must not
 * know the database, run state, worktrees, or how the markers are read.
 */

/** The directory and file names git leaves behind while an operation is unfinished. */
export const SEQUENCER_MARKER_NAMES = [
  'rebase-merge',
  'rebase-apply',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'MERGE_HEAD',
] as const

export type SequencerMarkerName = (typeof SEQUENCER_MARKER_NAMES)[number]

export type SequencerMarkers = {
  rebaseMerge: boolean
  rebaseApply: boolean
  cherryPickHead: boolean
  revertHead: boolean
  mergeHead: boolean
}

export type SequencerOperation = 'rebase' | 'merge' | 'cherry-pick' | 'revert'

export type CheckpointCommitDecision =
  | { commit: true; operation: null }
  | { commit: false; operation: SequencerOperation }

/** The one place git's marker names meet the facts the decision reads. */
export function sequencerMarkersFrom(
  present: (marker: SequencerMarkerName) => boolean,
): SequencerMarkers {
  return {
    rebaseMerge: present('rebase-merge'),
    rebaseApply: present('rebase-apply'),
    cherryPickHead: present('CHERRY_PICK_HEAD'),
    revertHead: present('REVERT_HEAD'),
    mergeHead: present('MERGE_HEAD'),
  }
}

/**
 * A rebase reports first because its two backends leave different directories
 * and a worker most often stops partway through one; a cherry-pick and a
 * revert report before a merge because each is an unfinished single-commit
 * operation with a recorded HEAD of its own.
 */
export function decideCheckpointCommit(markers: SequencerMarkers): CheckpointCommitDecision {
  if (markers.rebaseMerge || markers.rebaseApply) return { commit: false, operation: 'rebase' }
  if (markers.cherryPickHead) return { commit: false, operation: 'cherry-pick' }
  if (markers.revertHead) return { commit: false, operation: 'revert' }
  if (markers.mergeHead) return { commit: false, operation: 'merge' }
  return { commit: true, operation: null }
}
