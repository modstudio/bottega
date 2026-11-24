// concern: tracked recipe executable doctor
/** Loads registered tracked recipes and presents missing host executables without duplicating recipe-load failures. */
import { existsSync } from 'node:fs'
import {
  missingRecipeExecutables,
  recipeExecutableRefusal,
} from '../recipe/recipe-executable-preflight.ts'
import { loadTrackedRecipe } from '../recipe/recipe-loader.ts'
import type { TrackedRecipe } from '../recipe/recipe-schema.ts'
import {
  lifecycleReportLines,
  resolvedProjectWorktreeLifecycle,
} from '../worktree/worktree-lifecycle.ts'
import type { DoctorReporter } from './doctor-reporter.ts'

type RecipeProject = {
  name: string
  path: string
  settings: { worktree?: Parameters<typeof lifecycleReportLines>[0][number]['worktree'] }
}

export function recipeExecutableDoctorLines(
  project: string,
  recipe: TrackedRecipe,
  lookup: (name: string) => boolean,
): string[] {
  const steps = [
    ...(recipe.pre ?? []).map((step) => ({ phase: 'pre', step })),
    ...recipe.create.map((step) => ({ phase: 'create', step })),
    ...(recipe.refresh ?? []).map((step) => ({ phase: 'refresh', step })),
    ...(recipe.seeds?.reseed ? [{ phase: 'reseed', step: recipe.seeds.reseed }] : []),
    ...Object.entries(recipe.serve ?? {}).flatMap(([mode, modeSteps]) =>
      modeSteps.map((step) => ({ phase: `serve:${mode}`, step })),
    ),
    ...(recipe.destroy ?? []).map((step) => ({ phase: 'destroy', step })),
    ...(recipe.verifyDown ?? []).map((step) => ({ phase: 'verifyDown', step })),
  ]
  return missingRecipeExecutables(steps, lookup).map(
    (missing) => `recipe tool    MISSING — ${recipeExecutableRefusal(project, missing)}`,
  )
}

export function reportProjectLifecycles(
  projects: readonly RecipeProject[],
  presentation: DoctorReporter,
): void {
  for (const line of lifecycleReportLines(
    projects.map((project) => ({
      name: project.name,
      path: project.path,
      worktree: project.settings.worktree,
    })),
    existsSync,
  )) {
    presentation.log(line)
  }
  for (const project of projects) {
    const resolution = resolvedProjectWorktreeLifecycle(
      project.settings.worktree,
      project.path,
      existsSync,
    )
    if (resolution.form !== 'tracked-recipe') continue
    const loaded = loadTrackedRecipe(project.path, resolution.recipePath)
    if (!loaded.ok || !loaded.recipe) continue
    const lines = recipeExecutableDoctorLines(
      project.name,
      loaded.recipe,
      (name) => Bun.which(name, { PATH: process.env.PATH }) !== null,
    )
    for (const line of lines) presentation.log(line)
    if (lines.length) presentation.exitCode(1)
  }
}
