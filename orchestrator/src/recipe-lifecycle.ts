// concern: tracked recipe lifecycle planning
/** Plans tracked recipe lifecycle order and failure selection without executing or persisting anything. */
import type { TrackedRecipe } from './recipe-schema.ts'
import type { Step, StepResult } from './recipe-step.ts'

const deferred = { shared: 8 } as const

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

export function serveUndoPlan(recipe: TrackedRecipe): Step[] {
  return Object.values(recipe.serve ?? {}).flatMap((steps) => [...steps].reverse())
}

export function teardownVars(input: {
  path: string
  branch: string
  base: string
  key: string | null
  seed: string | null
  main: string
  allocations?: {
    index: number
    ports: Record<string, number>
    databases: Record<string, string>
    strings: Record<string, string>
  }
}): Record<string, string> {
  const vars: Record<string, string> = {
    path: input.path,
    name: input.path.split('/').pop() ?? input.path,
    branch: input.branch,
    base: input.base,
    key: input.key ?? '',
    seed: input.seed ?? '',
    main: input.main,
  }
  if (!input.allocations) return vars
  vars.index = String(input.allocations.index)
  for (const [name, port] of Object.entries(input.allocations.ports)) {
    vars[`ports.${name}`] = String(port)
  }
  for (const [name, value] of Object.entries(input.allocations.databases ?? {})) {
    vars[`db.${name}`] = value
  }
  for (const [name, value] of Object.entries(input.allocations.strings)) {
    vars[`alloc.${name}`] = value
  }
  return vars
}

export function lifecycleFailure(results: readonly StepResult[]): StepResult | null {
  return results.find((result) => result.status !== 'ok') ?? null
}

/**
 * A tree with no recorded recipe was built before its project tracked one, so the
 * recipe that built it is unknown. Its tree is rebuildable and removed as a plain
 * tree; a live database claim is the one leftover that removal would orphan, so it
 * keeps the tree and reports.
 */
export function snapshotlessTeardown(liveDatabaseClaims: number): 'remove' | 'keep' {
  return liveDatabaseClaims > 0 ? 'keep' : 'remove'
}
