// concern: run-claim-plan
/**
 * Decides where a claimed run works. Knows only resolved tree and project
 * lifecycle facts. Must not create trees, touch stores, or run processes.
 */

export type ClaimTreePlanFacts = {
  hasResolvedTaskWorktree: boolean
  forbidsRepo: boolean
  repoJob: boolean
  hasWorktree: boolean
  toolLifecycle: 'command-template' | 'recipe' | 'built-in-git'
  resumeUsesCreateTool: boolean | null
}

export type ClaimTreePlanRuling =
  | { mode: 'attach' }
  | { mode: 'isolate' }
  | {
      mode: 'create'
      lifecycle: ClaimTreePlanFacts['toolLifecycle']
      useCreateTool: boolean
    }
  | { mode: 'caller' }

/** Decide the claimed run's working-tree mode before performing any effects. */
export function decideClaimTreePlan(facts: ClaimTreePlanFacts): ClaimTreePlanRuling {
  if (facts.hasResolvedTaskWorktree) return { mode: 'attach' }
  if (facts.forbidsRepo) return { mode: 'isolate' }
  if (facts.repoJob && !facts.hasWorktree) {
    return {
      mode: 'create',
      lifecycle: facts.toolLifecycle,
      useCreateTool: facts.resumeUsesCreateTool ?? false,
    }
  }
  return { mode: 'caller' }
}

export function resumeCreationLifecycle(facts: {
  hasCreate: boolean
  hasRecipe: boolean
  hasRecipePath: boolean
}): ClaimTreePlanFacts['toolLifecycle'] {
  if (facts.hasCreate) return 'command-template'
  if (facts.hasRecipe || facts.hasRecipePath) return 'recipe'
  return 'built-in-git'
}

export function resumeCreationTool<T>(useCreateTool: boolean, tool: T | null): T | null {
  return useCreateTool ? tool : null
}

export function taskBranchKey<T>(launchKey: string | null, plan: T | undefined): string | null {
  return plan ? null : launchKey
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
