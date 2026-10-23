// concern: discard-worktree-absence
/** Classify a missing discard tree from recorded close-out. Must not know storage, git, or the CLI. */

const RELEASED_CLOSE_OUT = new Set(['released', 'absent', 'forgotten'])

export type DiscardWorktreeAbsence = 'already-released' | 'none'

export function discardWorktreeAbsence(closeOutOutcome: string | null): DiscardWorktreeAbsence {
  return closeOutOutcome && RELEASED_CLOSE_OUT.has(closeOutOutcome) ? 'already-released' : 'none'
}

export function alreadyReleasedWorktreeLine(id: string): string {
  return `run ${id}'s worktree was already released by stop or close-out`
}
