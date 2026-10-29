// concern: run-claim-plan
/**
 * Decides where a claimed run works. Knows only resolved tree and project
 * lifecycle facts. Must not create trees, touch stores, or run processes.
 */

import type { ResumeCreationLifecycle } from './resume-tree.ts'
import { isSyntheticLifecycleJob } from './synthetic-lifecycle-job.ts'

export type ClaimTreePlanFacts = {
  resolvedTaskWorktree: {
    path: string
    branch: string
    ownerJob: string | null
    freshBase: string
  } | null
  forbidsRepo: boolean
  repoJob: boolean
  hasWorktree: boolean
}

export type ClaimTreePlanRuling =
  | { mode: 'attach' }
  | { mode: 'refuse'; path: string; branch: string; freshBase: string; ownerJob: string }
  | { mode: 'isolate' }
  | { mode: 'create' }
  | { mode: 'caller' }

type AcceptedClaimTreePlan = Exclude<ClaimTreePlanRuling, { mode: 'refuse' }>

export type RetryRootTreeValidation = { branch: string; tip: string }

/** Decide whether recording a retry tree must revalidate a writing branch and tip. */
export function retryRootTreeValidation(input: {
  kind: string | null
  treePlan: RetryRootTreeValidation | null
  readOnlyBase: string | null
}): RetryRootTreeValidation | null {
  if (input.kind !== 'retry-root') return null
  if (input.readOnlyBase && !input.treePlan) return null
  return input.treePlan
}

export function claimedRunBranch(
  reviewTargetBranch: string | null,
  implicitReviewBranch: string | null,
  rootReviewBranch: string | null,
  worktreeBranch: string | null,
): string | null {
  return reviewTargetBranch ?? implicitReviewBranch ?? rootReviewBranch ?? (worktreeBranch || null)
}

/** Decide the claimed run's working-tree mode before performing any effects. */
export function decideClaimTreePlan(facts: ClaimTreePlanFacts): ClaimTreePlanRuling {
  if (
    facts.resolvedTaskWorktree?.ownerJob &&
    isSyntheticLifecycleJob(facts.resolvedTaskWorktree.ownerJob)
  ) {
    return {
      mode: 'refuse',
      path: facts.resolvedTaskWorktree.path,
      branch: facts.resolvedTaskWorktree.branch,
      freshBase: facts.resolvedTaskWorktree.freshBase,
      ownerJob: facts.resolvedTaskWorktree.ownerJob,
    }
  }
  if (facts.resolvedTaskWorktree) return { mode: 'attach' }
  if (facts.forbidsRepo) return { mode: 'isolate' }
  if (facts.repoJob && !facts.hasWorktree) return { mode: 'create' }
  return { mode: 'caller' }
}

/** Adapt one resolved task-branch candidate into a pre-effect claim plan. */
export function claimTreePlanForCandidate<T extends { path: string }>(input: {
  candidate: {
    branch: string
    trunk: string
    worktree: T | null
    worktreeOwnerJob: string | null
  } | null
  forbidsRepo: boolean
  repoJob: boolean
  hasWorktree: boolean
  refusalMessage: (refusal: Extract<ClaimTreePlanRuling, { mode: 'refuse' }>) => string
}) {
  const attachedTree = input.candidate?.worktree ?? null
  const claimTreePlan = decideClaimTreePlan({
    resolvedTaskWorktree:
      input.candidate && attachedTree
        ? {
            path: attachedTree.path,
            branch: input.candidate.branch,
            ownerJob: input.candidate.worktreeOwnerJob,
            freshBase: input.candidate.trunk,
          }
        : null,
    forbidsRepo: input.forbidsRepo,
    repoJob: input.repoJob,
    hasWorktree: input.hasWorktree,
  })
  if (claimTreePlan.mode === 'refuse') throw new Error(input.refusalMessage(claimTreePlan))
  return { attachedTree, claimTreePlan: claimTreePlan as AcceptedClaimTreePlan }
}

export function resumeCreationLifecycle(facts: {
  hasCreate: boolean
  hasRecipe: boolean
  hasRecipePath: boolean
}): ResumeCreationLifecycle {
  if (facts.hasCreate) return 'command-template'
  if (facts.hasRecipe || facts.hasRecipePath) return 'recipe'
  return 'built-in-git'
}

export function resumeCreationTool<T>(useCreateTool: boolean, tool: T | null): T | null {
  return useCreateTool ? tool : null
}

export function taskBranchKey(launchKey: string | null, hasResumePlan: boolean): string | null {
  return hasResumePlan ? null : launchKey
}

export function shouldResolveTaskBranch(input: {
  repoJob: boolean
  writesJob: boolean
  hasWorktree: boolean
  taskKey: string | null
  isResume: boolean
  hasExplicitBase: boolean
  taskBranchSupplied: boolean
}): boolean {
  return (
    (input.taskBranchSupplied || input.isResume) &&
    input.repoJob &&
    input.writesJob &&
    !input.hasWorktree &&
    input.taskKey !== null &&
    (!input.hasExplicitBase || input.isResume)
  )
}
