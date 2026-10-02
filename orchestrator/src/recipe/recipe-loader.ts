// concern: tracked worktree recipe loading
/** Knows how to resolve, read, parse, and validate one tracked recipe. Must not execute it or know register persistence. */
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { git, gitOk, resolveBase } from '../git/git-environment.ts'
import { configDocumentSchema, type TrackedRecipe } from './recipe-schema.ts'

export type LoadTrackedRecipeResult =
  | { ok: true; recipe: TrackedRecipe | null }
  | { ok: false; errors: string[] }

export function recipePointerErrors(recipePath: string): string[] {
  if (!recipePath.trim()) return ['recipe path rule: recipePath must be a non-empty relative path']
  if (isAbsolute(recipePath) || recipePath.split(/[\\/]+/).includes('..')) {
    return [
      'recipe path rule: recipePath must be relative to the project root and contain no .. segment',
    ]
  }
  return []
}

export function loadTrackedRecipe(
  projectPath: string,
  recipePath: string,
): LoadTrackedRecipeResult {
  const pointerErrors = recipePointerErrors(recipePath)
  if (pointerErrors.length) return { ok: false, errors: pointerErrors }
  const path = resolve(projectPath, recipePath)
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch (error) {
    return {
      ok: false,
      errors: [
        `tracked recipe ${path} could not be read: ${String((error as Error)?.message ?? error)}`,
      ],
    }
  }
  return parseTrackedRecipe(source, path)
}

function parseTrackedRecipe(source: string, label: string): LoadTrackedRecipeResult {
  let parsed: unknown
  try {
    parsed = Bun.JSONC.parse(source)
  } catch (error) {
    return {
      ok: false,
      errors: [
        `tracked recipe ${label} could not be parsed as JSONC: ${String((error as Error)?.message ?? error)}`,
      ],
    }
  }
  const result = configDocumentSchema.safeParse(parsed)
  if (result.success) return { ok: true, recipe: result.data.worktree ?? null }
  return {
    ok: false,
    errors: result.error.issues.map((issue) => {
      const at = issue.path.length ? `${issue.path.join('.')}: ` : ''
      const message =
        issue.code === 'unrecognized_keys'
          ? `unknown-key rule: unknown key ${issue.keys.map((key) => `"${key}"`).join(', ')}`
          : issue.message
      return `tracked recipe ${label}: ${at}${message}`
    }),
  }
}

export function loadRecipeAtBase(input: {
  recipePath: string
  repoRoot: string
  baseRef?: string
}): {
  base: string
  recipe: TrackedRecipe
  snapshot: { source: { path: string; commit: string }; recipe: TrackedRecipe }
} {
  const pointer = input.recipePath
  let base = input.baseRef
    ? resolveBase(input.repoRoot, input.baseRef)
    : git(['rev-parse', 'HEAD'], input.repoRoot)
  const read = () => {
    let source: string
    try {
      source = git(['show', `${base}:${pointer}`], input.repoRoot)
    } catch (error) {
      throw new Error(
        `tracked recipe ${pointer} at ${base} could not be read: ${String((error as Error)?.message ?? error)}`,
      )
    }
    const loaded = parseTrackedRecipe(source, `${pointer} at ${base}`)
    if (!loaded.ok) throw new Error(loaded.errors.join('\n'))
    return loaded.recipe ?? { create: [] }
  }
  let recipe = read()
  if (!input.baseRef && recipe.baseRef) {
    base =
      gitOk(['rev-parse', recipe.baseRef], input.repoRoot) ??
      git(['rev-parse', 'HEAD'], input.repoRoot)
    recipe = read()
  }
  return { base, recipe, snapshot: { source: { path: pointer, commit: base }, recipe } }
}
