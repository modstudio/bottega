// concern: stray worktree directory decision
/** Pure cleanup policy for non-git directories found below a project's worktrees root. */

// A provisioner gets a full hour to finish creating and registering a tree before
// cleanup may consider it abandoned. Directory creation and Git setup normally
// complete together, so this also protects a tree whose creation is in progress.
export const STRAY_WORKTREE_QUIET_WINDOW_MS = 60 * 60_000

export type StrayWorktreeFacts = {
  established: boolean
  claimed: boolean
  ageMs: number
}

export type StrayWorktreeDecision = 'report-only' | 'keep-claimed' | 'keep-recent' | 'archive'

export function strayWorktreeDecision(facts: StrayWorktreeFacts): StrayWorktreeDecision {
  if (!facts.established) return 'report-only'
  if (facts.claimed) return 'keep-claimed'
  if (facts.ageMs <= STRAY_WORKTREE_QUIET_WINDOW_MS) return 'keep-recent'
  return 'archive'
}
