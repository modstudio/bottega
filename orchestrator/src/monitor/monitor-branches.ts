// concern: monitor-branches
/** Selects recorded branches that still exist locally without an attached worktree. */

export type BranchCandidate = {
  branch: string
  started_at: string
}

export function existingBranchesWithoutWorktrees(
  candidates: readonly BranchCandidate[],
  worktreeRefs: readonly string[],
  existingHeads: readonly string[],
): BranchCandidate[] {
  const checkedOut = new Set(worktreeRefs)
  const existing = new Set(existingHeads)
  return candidates.filter(
    (candidate) => !checkedOut.has(candidate.branch) && existing.has(candidate.branch),
  )
}
