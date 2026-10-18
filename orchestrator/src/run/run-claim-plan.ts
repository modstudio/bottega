// concern: run-claim-plan
/**
 * Decides where a claimed run works. Knows only resolved tree and project
 * lifecycle facts. Must not create trees, touch stores, or run processes.
 */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ResumeCreationLifecycle } from './resume-tree.ts'

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
  | { mode: 'refuse'; path: string; branch: string; freshBase: string }
  | { mode: 'isolate' }
  | { mode: 'create' }
  | { mode: 'caller' }

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
  if (facts.resolvedTaskWorktree?.ownerJob === 'landing-tree') {
    return {
      mode: 'refuse',
      path: facts.resolvedTaskWorktree.path,
      branch: facts.resolvedTaskWorktree.branch,
      freshBase: facts.resolvedTaskWorktree.freshBase,
    }
  }
  if (facts.resolvedTaskWorktree) return { mode: 'attach' }
  if (facts.forbidsRepo) return { mode: 'isolate' }
  if (facts.repoJob && !facts.hasWorktree) return { mode: 'create' }
  return { mode: 'caller' }
}

/** Compose the operator remedy when an architect landing tree owns the reused branch. */
export function claimTreePlanRefusal(
  refusal: Extract<ClaimTreePlanRuling, { mode: 'refuse' }>,
): string {
  return (
    `refusing task branch ${refusal.branch}: it is checked out in architect landing tree ${refusal.path}.\n` +
    `cleared by: ${PLATFORM_SLUG} tree remove ${refusal.path}, then dispatch again; ` +
    `or dispatch again with --base ${refusal.freshBase} to start a fresh branch`
  )
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
}): boolean {
  return (
    input.repoJob &&
    input.writesJob &&
    !input.hasWorktree &&
    input.taskKey !== null &&
    (!input.hasExplicitBase || input.isResume)
  )
}
