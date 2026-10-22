// concern: monitor-branches
/** Selects recorded branches that still exist locally without an attached worktree. */

export type BranchCandidate = {
  branch: string
  started_at: string
}

function branchReclaimAction(branch: string, actions: ReadonlyMap<string, string>): string {
  return actions.get(branch)!
}

export function branchMonitorConditions(
  project: string,
  candidates: readonly BranchCandidate[],
  actions: ReadonlyMap<string, string>,
) {
  return candidates.map((candidate) => ({
    kind: 'branch-without-worktree' as const,
    subject: `${project}:${candidate.branch}`,
    since: candidate.started_at,
    detail: `${project} branch ${candidate.branch} has no worktree`,
    action: branchReclaimAction(candidate.branch, actions),
    affectedProject: project,
  }))
}

export function branchInventoryDecision(
  project: string,
  candidates: readonly BranchCandidate[],
  worktreeRefs: readonly string[],
  localHeads: string | null,
): { branches: BranchCandidate[]; errors: string[] } {
  if (localHeads === null)
    return {
      branches: [],
      errors: [`${project} branch inventory: git for-each-ref failed`],
    }
  return {
    branches: existingBranchesWithoutWorktrees(
      candidates,
      worktreeRefs,
      localHeads.split('\n').filter(Boolean),
    ),
    errors: [],
  }
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
