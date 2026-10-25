// concern: tracked worktree recipe loading
/** Knows how to resolve, read, parse, and validate one tracked recipe, and the base a project's lifecycle declares. Must not execute it or know register persistence. */
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
  /**
   * The `baseRef` the recipe read at `base` declared; null when it named none.
   *
   * Taken from the FIRST read, before the base a recipe names is followed, so
   * it answers what the recipe at `base` says rather than what the commit it
   * points at happens to repeat. A recipe that names a base is not repeated
   * there in general: the commit it points at may name none.
   */
  declaredBaseRef: string | null
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
  const declaredBaseRef = recipe.baseRef ?? null
  if (!input.baseRef && recipe.baseRef) {
    base =
      gitOk(['rev-parse', recipe.baseRef], input.repoRoot) ??
      git(['rev-parse', 'HEAD'], input.repoRoot)
    recipe = read()
  }
  return {
    base,
    recipe,
    declaredBaseRef,
    snapshot: { source: { path: pointer, commit: base }, recipe },
  }
}

/**
 * The base a project's lifecycle declares for a new tree; null when it names
 * none.
 *
 * A declared recipe carries `baseRef` so a project that branches from
 * `origin/develop` can say so, and the register's inline recipe and the tracked
 * recipe are two spellings of one declaration: a base named in either is the
 * project's own floor, and creation follows it. Both spellings are passed in
 * rather than looked up, because which project declares which belongs to the
 * register and not here.
 *
 * The tracked recipe's declaration comes from the read at `repoRoot`'s HEAD,
 * before the base it names is followed, because following it lands on a commit
 * whose recipe may name nothing.
 *
 * A recipe that cannot be read here is not refused here: creation reads the
 * same file for real and reports its own refusal, so this falls open to null.
 */
export function declaredRecipeBaseRef(input: {
  /** The register's inline recipe, when the project declares one. */
  registerRecipe?: { baseRef?: string } | null
  /** The tracked recipe pointer, when the project declares one. */
  recipePath?: string | null
  /** The repository the tracked recipe is read in. */
  repoRoot: string
}): string | null {
  if (input.registerRecipe?.baseRef) return input.registerRecipe.baseRef
  if (!input.recipePath) return null
  try {
    return loadRecipeAtBase({ recipePath: input.recipePath, repoRoot: input.repoRoot })
      .declaredBaseRef
  } catch {
    return null
  }
}
