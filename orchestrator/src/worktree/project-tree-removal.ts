// concern: unowned project tree removal guidance
/** Resolves a project's declared removal command without executing it and chooses the refusal remedy. */

import { basename } from 'node:path'
import type { WorktreeTool } from '../project/projects.ts'
import { destroyPlan } from '../recipe/recipe-lifecycle.ts'
import { loadTrackedRecipe } from '../recipe/recipe-loader.ts'
import { stepPlaceholders } from '../recipe/recipe-schema.ts'
import { stepCommandPlan } from '../recipe/recipe-step.ts'
import { shellQuote } from '../resources/git-locks.ts'
import { fillTool } from './worktree-template.ts'

export function unownedProjectTreeRemovalRemedy(input: {
  declaredRemoveCommand: string | null
  treePath: string
  mainCheckoutPath: string
}): string {
  const command =
    input.declaredRemoveCommand ??
    `git -C ${input.mainCheckoutPath} worktree remove ${input.treePath}`
  const release = input.declaredRemoveCommand
    ? ', which also releases what the project provisioned for it'
    : ''
  return `if the orchestrator did not make this tree, confirm it is clean and its commits are pushed, then run ${command}${release}`
}

function availableRemovalVars(treePath: string, mainCheckoutPath: string): Record<string, string> {
  return {
    path: treePath,
    name: basename(treePath),
    main: mainCheckoutPath,
    tree_exists: 'true',
  }
}

function unavailableTemplatePlaceholder(
  template: string,
  vars: Record<string, string>,
): string | null {
  return (
    [...template.matchAll(/\{(\w+)\}/g)]
      .map((match) => match[1]!)
      .find((name) => !(name in vars)) ?? null
  )
}

/** Render the same declared command or tracked-recipe teardown steps used by lifecycle removal. */
export function declaredProjectTreeRemoveCommand(
  tool: WorktreeTool | null,
  treePath: string,
  mainCheckoutPath: string,
): string | null {
  if (!tool) return null
  const vars = availableRemovalVars(treePath, mainCheckoutPath)
  if (tool.remove) {
    const missing = unavailableTemplatePlaceholder(tool.remove, vars)
    if (missing) {
      throw new Error(
        `project remove template references unavailable placeholder {${missing}} for unrecorded worktree ${treePath}`,
      )
    }
    return fillTool(tool.remove, vars)
  }
  if (!tool.recipePath) return null

  const loaded = loadTrackedRecipe(mainCheckoutPath, tool.recipePath)
  if (!loaded.ok) throw new Error(loaded.errors.join('; '))
  if (!loaded.recipe) return null
  const planned = destroyPlan(loaded.recipe)
  if (!planned.length) return null

  return planned
    .map(({ step, phase }) => {
      const command = phase === 'run' ? step.run : step.undo!
      const missing = stepPlaceholders(command).find(({ name }) => !(name in vars))
      if (missing) {
        throw new Error(
          `tracked recipe remove step "${step.name}" references unavailable placeholder {${missing.name}} for unrecorded worktree ${treePath}`,
        )
      }
      const plan = stepCommandPlan(
        command,
        step.exec,
        { treeRoot: treePath, vars },
        step.name,
        phase,
      )
      if (!plan.ok) throw new Error(plan.reason)
      return `(cd ${shellQuote(plan.cwd)} && ${plan.argv.map(shellQuote).join(' ')})`
    })
    .join(' && ')
}
