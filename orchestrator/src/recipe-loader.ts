// concern: tracked worktree recipe loading
/** Knows how to resolve, read, parse, and validate one tracked recipe. Must not execute it or know register persistence. */
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { recipeSchema, type TrackedRecipe } from './recipe-schema.ts'

export type LoadTrackedRecipeResult =
  | { ok: true; recipe: TrackedRecipe }
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
  let parsed: unknown
  try {
    parsed = Bun.JSONC.parse(source)
  } catch (error) {
    return {
      ok: false,
      errors: [
        `tracked recipe ${path} could not be parsed as JSONC: ${String((error as Error)?.message ?? error)}`,
      ],
    }
  }
  const result = recipeSchema.safeParse(parsed)
  if (result.success) return { ok: true, recipe: result.data }
  return {
    ok: false,
    errors: result.error.issues.map((issue) => {
      const at = issue.path.length ? `${issue.path.join('.')}: ` : ''
      const message =
        issue.code === 'unrecognized_keys' ? `unknown-key rule: ${issue.message}` : issue.message
      return `tracked recipe ${path}: ${at}${message}`
    }),
  }
}
