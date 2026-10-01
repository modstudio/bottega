import { repoRootOf } from '../git/git-environment.ts'
import type { WorktreeTool } from '../project/projects.ts'
import { recipeNotes } from '../recipe/recipe.ts'
import { trackedRecipeNotes } from '../recipe/tracked-recipe.ts'

function generatedNotes(tool: WorktreeTool, callerCwd: string): string {
  if (tool.recipe) return recipeNotes(tool.recipe, "<this worktree's database>", '')
  if (tool.recipePath) return trackedRecipeNotes(tool, repoRootOf(callerCwd) ?? callerCwd)
  return ''
}

export function runInfrastructurePrompt(input: {
  tool: WorktreeTool | null
  callerCwd: string
  readsRepo: boolean
  writesRepo: boolean
  readOnlyBase: string | null
}): string {
  const { tool } = input
  if (!tool) return ''
  const generated =
    input.writesRepo || (tool.readonly_create && tool.readonly_notes === undefined)
      ? generatedNotes(tool, input.callerCwd)
      : ''
  return readonlyInfrastructurePrompt({
    readsRepo: input.readsRepo,
    writesRepo: input.writesRepo,
    readonlyCreate: Boolean(tool.readonly_create),
    readonlyNotes: tool.readonly_notes,
    readOnlyBase: input.readOnlyBase,
    regularNotes: tool.notes ?? '',
    generatedNotes: generated,
  })
}

export function readonlyInfrastructurePrompt(input: {
  readsRepo: boolean
  writesRepo: boolean
  readonlyCreate: boolean
  readonlyNotes?: string
  readOnlyBase: string | null
  regularNotes: string
  generatedNotes: string
}): string {
  if (!input.readsRepo) return ''

  let infrastructure: string
  if (!input.writesRepo && (!input.readonlyCreate || input.readonlyNotes !== undefined)) {
    const tree =
      input.readonlyNotes !== undefined
        ? `This read-only run has the project's files at ${input.readOnlyBase}. ${input.readonlyNotes}`
        : `This read-only run has the project's files at ${input.readOnlyBase} with NO provisioned ` +
          `infrastructure (no databases, no generated env, no vendor tree).`
    infrastructure =
      `${tree} Do not treat a test suite that cannot start as a finding; ` +
      `record what you could not run in could_not_verify. ORCH_MAIN_CHECKOUT names the ` +
      `registered project's main checkout when project tooling needs it.`
  } else {
    infrastructure = [input.regularNotes, input.generatedNotes].filter(Boolean).join('\n\n')
  }
  return infrastructure
}
