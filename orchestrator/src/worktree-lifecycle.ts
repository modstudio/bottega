// concern: worktree lifecycle measurement
/** Knows declared lifecycle shapes and recipe-schema support. Must not know execution, the register, databases, or the CLI. */
import { resolve } from 'node:path'
import { type LoadTrackedRecipeResult, loadTrackedRecipe } from './recipe-loader.ts'

export type LifecycleForm = 'command-templates' | 'inline-recipe' | 'tracked-recipe' | 'none'

type WorktreeDeclaration = {
  recipePath?: unknown
  recipe?: unknown
  create?: unknown
  remove?: unknown
  sweep?: unknown
}

export type TrackedRecipeStatus = {
  path: string
  exists: boolean
}

export type RecipeElementSupport = {
  supported: string[]
  unsupported: string[]
  unknown: string[]
  migrationGaps: string[]
}

type LifecycleProject = {
  name: string
  path: string
  worktree?: WorktreeDeclaration
}

const LEGACY_KEYS = new Set([
  'baseRef',
  'install',
  'env',
  'database',
  'migrate',
  'serve',
  'stop',
  'after',
])
const TARGET_ONLY_KEYS = new Set(['allocate', 'shared', 'pre', 'create', 'destroy', 'verifyDown'])

/** Classify only what the project declared; never infer a lifecycle from repository contents. */
export function lifecycleForm(worktree: WorktreeDeclaration | null | undefined): LifecycleForm {
  if (!worktree) return 'none'
  if (typeof worktree.recipePath === 'string' && worktree.recipePath.trim()) {
    return 'tracked-recipe'
  }
  if (worktree.recipe !== undefined) return 'inline-recipe'
  if (
    worktree.create !== undefined ||
    worktree.remove !== undefined ||
    worktree.sweep !== undefined
  ) {
    return 'command-templates'
  }
  return 'none'
}

/** Resolve and probe a tracked pointer without reading or parsing the recipe. */
export function trackedRecipeStatus(
  projectPath: string,
  worktree: WorktreeDeclaration | null | undefined,
  fileExists: (path: string) => boolean,
): TrackedRecipeStatus | null {
  if (lifecycleForm(worktree) !== 'tracked-recipe') return null
  const pointer = (worktree!.recipePath as string).trim()
  const path = resolve(projectPath, pointer)
  return { path, exists: fileExists(path) }
}

/** Measure which inline keys today's runner handles and which belong to the target envelope. */
export function recipeElementSupport(recipe: unknown): RecipeElementSupport {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
    return { supported: [], unsupported: [], unknown: [], migrationGaps: [] }
  }
  const value = recipe as Record<string, unknown>
  const supported: string[] = []
  const unsupported: string[] = []
  const unknown: string[] = []
  for (const key of Object.keys(value)) {
    const status = elementStatus(key, value[key])
    if (status === 'supported') supported.push(key)
    else if (status === 'unsupported') unsupported.push(key)
    else unknown.push(key)
  }
  const migrationGaps = legacyMigrationGaps(value)
  migrationGaps.push(...unsupported.filter((key) => !migrationGaps.includes(key)))
  return { supported, unsupported, unknown, migrationGaps }
}

function elementStatus(key: string, value: unknown): 'supported' | 'unsupported' | 'unknown' {
  if (key === 'env' && Array.isArray(value)) return 'unsupported'
  if (key === 'serve' && isRecord(value)) return 'unsupported'
  if (LEGACY_KEYS.has(key)) return 'supported'
  if (TARGET_ONLY_KEYS.has(key)) return 'unsupported'
  return 'unknown'
}

function legacyMigrationGaps(value: Record<string, unknown>): string[] {
  const migrationGaps: string[] = []
  if (['install', 'migrate', 'after'].some((key) => key in value)) {
    migrationGaps.push('ordered create steps')
  }
  if ('env' in value) migrationGaps.push('plural env files')
  if (isRecord(value.database) && value.database.kind !== 'none') {
    migrationGaps.push('named databases')
  }
  if ('serve' in value) migrationGaps.push('named serve modes', 'named ports')
  if ('stop' in value) migrationGaps.push('owned stop verb')
  return migrationGaps
}

export function declaredCommandTemplates(
  worktree: WorktreeDeclaration | null | undefined,
): string[] {
  if (!worktree) return []
  return ['create', 'remove', 'sweep'].filter(
    (key) => worktree[key as keyof WorktreeDeclaration] !== undefined,
  )
}

export function declaredInlineElements(recipe: unknown): string[] {
  if (!isRecord(recipe)) return []
  return Object.entries(recipe).map(([key, value]) => {
    if (key === 'database' && isRecord(value) && typeof value.kind === 'string') {
      return `database:${value.kind}`
    }
    return key
  })
}

/** Compose doctor lines from measurements; the caller supplies the filesystem observation. */
export function lifecycleReportLines(
  projects: LifecycleProject[],
  fileExists: (path: string) => boolean,
  loadRecipe: (
    projectPath: string,
    recipePath: string,
  ) => LoadTrackedRecipeResult = loadTrackedRecipe,
): string[] {
  const forms = projects.map((project) => lifecycleForm(project.worktree))
  const lines = projects.map((project, index) =>
    projectLifecycleLine(project, forms[index]!, fileExists, loadRecipe),
  )
  const count = (form: LifecycleForm) => forms.filter((candidate) => candidate === form).length
  lines.push(
    `recipes: ${count('tracked-recipe')} tracked, ${count('inline-recipe')} inline, ${count('command-templates')} command-template projects`,
  )
  return lines
}

function projectLifecycleLine(
  project: LifecycleProject,
  form: LifecycleForm,
  fileExists: (path: string) => boolean,
  loadRecipe: (projectPath: string, recipePath: string) => LoadTrackedRecipeResult,
): string {
  const worktree = project.worktree
  if (form === 'command-templates') {
    const verbs = declaredCommandTemplates(worktree)
    return `lifecycle ${project.name}: command-templates (${verbs.join(', ')}); target recipe not declared`
  }
  if (form === 'inline-recipe') {
    const elements = declaredInlineElements(worktree?.recipe)
    const support = recipeElementSupport(worktree?.recipe)
    const suffixes = [
      support.migrationGaps.length
        ? `unsupported for migration: ${support.migrationGaps.join(', ')}`
        : null,
      support.unknown.length ? `unknown keys: ${support.unknown.join(', ')}` : null,
    ].filter(Boolean)
    return `lifecycle ${project.name}: inline-recipe (${elements.join(', ') || 'empty'}); ${suffixes.join('; ') || 'migration-ready'}`
  }
  if (form === 'tracked-recipe') {
    const pointer = worktree?.recipePath as string
    const status = trackedRecipeStatus(project.path, worktree, fileExists)!
    const loaded = loadRecipe(project.path, pointer)
    if (loaded.ok) {
      return `lifecycle ${project.name}: tracked-recipe (${pointer}); valid at ${status.path}`
    }
    return `lifecycle ${project.name}: tracked-recipe (${pointer}); invalid (${loaded.errors.length} error(s)); first: ${loaded.errors[0]}`
  }
  return `lifecycle ${project.name}: none; target recipe not declared`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
