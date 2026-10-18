// concern: run-task-branch-resolution
/** Resolves a supplied or register-backed task branch for a claimed run. */

import type { TaskBranchCandidate } from '../branch/task-branch.ts'
import { resolveCompatibleTaskBranch } from '../branch/task-branch-reuse.ts'
import { claimTreePlanRefusal, decideClaimTreePlan } from './run-claim-plan.ts'

export function taskBranchResolution(
  supplied: TaskBranchCandidate | null | undefined,
  callerCwd: string,
  key: string,
  dispatchingSession: string | null,
): TaskBranchCandidate | null {
  return supplied !== undefined
    ? supplied
    : resolveCompatibleTaskBranch(callerCwd, key, dispatchingSession)
}

/** Plan a resolved task branch before the run claim performs any effects. */
export function taskBranchClaimTreePlan(input: {
  resolvedTaskBranch: TaskBranchCandidate | null
  forbidsRepo: boolean
  repoJob: boolean
  hasWorktree: boolean
}) {
  const attachedTree = input.resolvedTaskBranch?.worktree ?? null
  const claimTreePlan = decideClaimTreePlan({
    resolvedTaskWorktree:
      input.resolvedTaskBranch && attachedTree
        ? {
            path: attachedTree.path,
            branch: input.resolvedTaskBranch.branch,
            ownerJob: input.resolvedTaskBranch.worktreeOwnerJob,
            freshBase: input.resolvedTaskBranch.trunk,
          }
        : null,
    forbidsRepo: input.forbidsRepo,
    repoJob: input.repoJob,
    hasWorktree: input.hasWorktree,
  })
  if (claimTreePlan.mode === 'refuse') throw new Error(claimTreePlanRefusal(claimTreePlan))
  return { attachedTree, claimTreePlan }
}
