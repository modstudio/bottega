// concern: worktree lifecycle measurement
/** Knows declared lifecycle shapes and recipe-schema support. Must not know execution, the register, databases, or the CLI. */
import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type LoadTrackedRecipeResult, loadTrackedRecipe } from '../recipe/recipe-loader.ts'

export type LifecycleForm = 'command-templates' | 'inline-recipe' | 'tracked-recipe' | 'none'
type TrackedRecipeSource = 'declared' | 'default'

export const DEFAULT_PROJECT_CONFIG_PATH = `${PLATFORM_SLUG}.jsonc`

type WorktreeDeclaration = {
  recipePath?: unknown
  recipe?: unknown
  create?: unknown
  remove?: unknown
  sweep?: unknown
  seeds?: unknown[]
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

export type LifecycleResolution =
  | { form: 'command-templates' | 'inline-recipe' | 'none' }
  | { form: 'tracked-recipe'; recipePath: string; source: TrackedRecipeSource }

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

/** Resolve the one lifecycle form used by validation, execution, and reporting. */
export function resolveWorktreeLifecycle(
  worktree: WorktreeDeclaration | null | undefined,
  defaultConfigExists = false,
): LifecycleResolution {
  if (worktree?.create !== undefined) {
    return { form: 'command-templates' }
  }
  if (worktree?.recipe !== undefined) return { form: 'inline-recipe' }
  if (typeof worktree?.recipePath === 'string') {
    return { form: 'tracked-recipe', recipePath: worktree.recipePath, source: 'declared' }
  }
  if (defaultConfigExists) {
    return { form: 'tracked-recipe', recipePath: DEFAULT_PROJECT_CONFIG_PATH, source: 'default' }
  }
  return { form: 'none' }
}

export function lifecycleForm(
  worktree: WorktreeDeclaration | null | undefined,
  defaultConfigExists = false,
): LifecycleForm {
  return resolveWorktreeLifecycle(worktree, defaultConfigExists).form
}

/** Resolve and probe a tracked pointer without reading or parsing the recipe. */
export function trackedRecipeStatus(
  projectPath: string,
  worktree: WorktreeDeclaration | null | undefined,
  fileExists: (path: string) => boolean,
): TrackedRecipeStatus | null {
  const defaultPath = resolve(projectPath, DEFAULT_PROJECT_CONFIG_PATH)
  let resolution = resolveWorktreeLifecycle(worktree)
  if (resolution.form === 'none') {
    resolution = resolveWorktreeLifecycle(worktree, fileExists(defaultPath))
  }
  if (resolution.form !== 'tracked-recipe') return null
  const pointer = resolution.recipePath.trim()
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

function declaredCommandTemplates(worktree: WorktreeDeclaration | null | undefined): string[] {
  if (!worktree) return []
  return ['create', 'remove', 'sweep'].filter(
    (key) => worktree[key as keyof WorktreeDeclaration] !== undefined,
  )
}

function declaredInlineElements(recipe: unknown): string[] {
  if (!isRecord(recipe)) return []
  return Object.entries(recipe).map(([key, value]) => {
    if (key === 'database' && isRecord(value) && typeof value.kind === 'string') {
      return `database:${value.kind}`
    }
    return key
  })
}

function trackedRecipeLifecycleLine(
  project: LifecycleProject,
  resolution: Extract<LifecycleResolution, { form: 'tracked-recipe' }>,
  fileExists: (path: string) => boolean,
  loadRecipe: (projectPath: string, recipePath: string) => LoadTrackedRecipeResult,
): string {
  const pointer = resolution.recipePath
  const status = trackedRecipeStatus(project.path, project.worktree, fileExists)!
  const loaded = loadRecipe(project.path, pointer)
  if (!loaded.ok) {
    return `lifecycle ${project.name}: tracked-recipe (${pointer}); invalid (${loaded.errors.length} error(s)); first: ${loaded.errors[0]}`
  }
  if (!loaded.recipe) {
    return `lifecycle ${project.name}: none; ${pointer} (${resolution.source}) declares no worktree lifecycle`
  }
  const shared = loaded.recipe.shared?.length ?? 0
  const declaration = shared > 0 ? `; shared: ${shared} declared` : ''
  const duplicateSeeds =
    loaded.recipe.seeds && project.worktree?.seeds?.length
      ? '; duplicate seeds: register worktree.seeds and tracked recipe seeds are both declared; recipe wins'
      : ''
  return `lifecycle ${project.name}: tracked-recipe (${pointer}, ${resolution.source}); valid at ${status.path}${declaration}${duplicateSeeds}`
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
  const resolutions = projects.map((project) => {
    const declared = resolveWorktreeLifecycle(project.worktree)
    return declared.form === 'none'
      ? resolveWorktreeLifecycle(
          project.worktree,
          fileExists(resolve(project.path, DEFAULT_PROJECT_CONFIG_PATH)),
        )
      : declared
  })
  const forms = resolutions.map((resolution) => resolution.form)
  const lines = projects.map((project, index) =>
    projectLifecycleLine(project, resolutions[index]!, fileExists, loadRecipe),
  )
  const count = (form: LifecycleForm) => forms.filter((candidate) => candidate === form).length
  lines.push(
    `recipes: ${count('tracked-recipe')} tracked, ${count('inline-recipe')} inline, ${count('command-templates')} command-template projects`,
  )
  return lines
}

function projectLifecycleLine(
  project: LifecycleProject,
  resolution: LifecycleResolution,
  fileExists: (path: string) => boolean,
  loadRecipe: (projectPath: string, recipePath: string) => LoadTrackedRecipeResult,
): string {
  const form = resolution.form
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
    return trackedRecipeLifecycleLine(project, resolution, fileExists, loadRecipe)
  }
  return `lifecycle ${project.name}: none; target recipe not declared`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
