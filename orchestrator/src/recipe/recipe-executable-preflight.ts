// concern: tracked recipe executable prerequisites
/** Knows which structured recipe commands can be resolved on the host. Must not read process state or execute steps. */
import type { Step } from './recipe-step.ts'

export type PhasedRecipeStep = { phase: string; step: Step }
export type MissingRecipeExecutable = { phase: string; step: string; tool: string }

/** Report host commands whose executable cannot be found without guessing through another context. */
export function missingRecipeExecutables(
  steps: readonly PhasedRecipeStep[],
  lookup: (name: string) => boolean,
): MissingRecipeExecutable[] {
  const missing: MissingRecipeExecutable[] = []
  for (const { phase, step } of steps) {
    if (step.exec?.where === 'container' || step.exec?.where === 'as-user') continue
    const tool = step.run.command
    if (tool.includes('{') || tool.includes('/')) continue
    if (!lookup(tool)) missing.push({ phase, step: step.name, tool })
  }
  return missing
}

export function recipeExecutableRefusal(project: string, missing: MissingRecipeExecutable): string {
  return `project ${project} worktree recipe step ${missing.step} (${missing.phase}) needs ${missing.tool}, which is not on PATH; install ${missing.tool}, then retry`
}

export class RecipePrerequisiteError extends Error {
  constructor(
    readonly project: string,
    readonly missing: readonly MissingRecipeExecutable[],
  ) {
    super(missing.map((entry) => recipeExecutableRefusal(project, entry)).join('\n'))
    this.name = 'RecipePrerequisiteError'
  }
}

export function assertRecipeExecutables(
  project: string,
  steps: readonly PhasedRecipeStep[],
  lookup: (name: string) => boolean,
): void {
  const missing = missingRecipeExecutables(steps, lookup)
  if (missing.length) throw new RecipePrerequisiteError(project, missing)
}
