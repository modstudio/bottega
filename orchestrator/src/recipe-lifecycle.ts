// concern: tracked recipe lifecycle planning
/** Plans tracked recipe lifecycle order and failure selection without executing or persisting anything. */
import type { TrackedRecipe } from './recipe-schema.ts'
import type { Step, StepResult } from './recipe-step.ts'

const deferred = { allocate: 5, env: 7, shared: 8, serve: 9 } as const

export function trackedExecutionRefusal(recipe: TrackedRecipe): string | null {
  for (const [field, slice] of Object.entries(deferred)) {
    if (recipe[field as keyof typeof deferred] !== undefined) {
      return `tracked recipe declares ${field}, which is not executable yet (Phase 3 slice ${slice})`
    }
  }
  return null
}

export function compensationPlan(recipe: TrackedRecipe, failedIndex: number): Step[] {
  return recipe.create
    .slice(0, failedIndex + 1)
    .filter((step) => step.undo)
    .reverse()
}

export function destroyPlan(recipe: TrackedRecipe): { step: Step; phase: 'run' | 'undo' }[] {
  return recipe.destroy
    ? recipe.destroy.map((step) => ({ step, phase: 'run' as const }))
    : recipe.create
        .filter((step) => step.undo)
        .reverse()
        .map((step) => ({ step, phase: 'undo' as const }))
}

export function teardownVars(input: {
  path: string
  branch: string
  base: string
  key: string | null
  seed: string | null
  main: string
}): Record<string, string> {
  return {
    path: input.path,
    name: input.path.split('/').pop() ?? input.path,
    branch: input.branch,
    base: input.base,
    key: input.key ?? '',
    seed: input.seed ?? '',
    main: input.main,
  }
}

export function lifecycleFailure(results: readonly StepResult[]): StepResult | null {
  return results.find((result) => result.status !== 'ok') ?? null
}
