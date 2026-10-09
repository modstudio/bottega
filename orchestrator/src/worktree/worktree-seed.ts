// concern: worktree-seed
/** Selects and validates the seed used to provision a writing worktree. */

import { seedGuidance } from '../cli/args.ts'
import type { projectAt, WorktreeTool } from '../project/projects.ts'
import { loadRecipeAtBase } from '../recipe/recipe-loader.ts'
import { resolveWorktreeLifecycle } from './worktree-lifecycle.ts'
import { validateSeedWithTool } from './worktree-preflight.ts'

type Project = NonNullable<ReturnType<typeof projectAt>>

export type SeedDecision = { seed: string | undefined; refusal: string | null }

export function seedPreflight(input: {
  requested: string | undefined
  inherited?: string | undefined
  registerChoices: string[] | undefined
  recipeSeeds: { choices: string[]; default?: string } | undefined
  writesRepo?: boolean
}): SeedDecision {
  if (input.writesRepo === false) return { seed: undefined, refusal: null }
  const choices = input.recipeSeeds?.choices ?? input.registerChoices
  const seed = input.requested ?? input.inherited ?? input.recipeSeeds?.default
  return {
    seed,
    refusal:
      choices?.length && !seed
        ? `this project requires a database size for a new worktree, and has no default.\n` +
          `${seedGuidance(choices)}\n\n` +
          `Choosing is the architect's call: it depends on what the task touches.`
        : null,
  }
}

function trackedRecipeSeeds(
  project: Project | null,
  tool: WorktreeTool | null,
  baseRef?: string,
): { choices: string[]; default?: string } | undefined {
  if (!project) return undefined
  const lifecycle = resolveWorktreeLifecycle(tool)
  if (lifecycle.form !== 'tracked-recipe') return undefined
  return loadRecipeAtBase({
    recipePath: lifecycle.recipePath,
    repoRoot: project.path,
    baseRef,
  }).recipe.seeds
}

export function projectSeedPreflight(input: {
  requested: string | undefined
  inherited?: string | undefined
  writesRepo: boolean
  project: Project | null
  tool: WorktreeTool | null
  baseRef?: string
}): SeedDecision {
  return seedPreflight({
    requested: input.requested,
    inherited: input.inherited,
    registerChoices: input.tool?.seeds,
    recipeSeeds: input.writesRepo
      ? trackedRecipeSeeds(input.project, input.tool, input.baseRef)
      : undefined,
    writesRepo: input.writesRepo,
  })
}

export function validateProjectSeed(project: Project, seed: string | undefined): void {
  validateSeedWithTool(project.path, seed)
}
