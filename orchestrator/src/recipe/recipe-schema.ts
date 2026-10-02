// concern: tracked worktree recipe schema
/** Knows only the stored recipe grammar and its refusal rules. Must not read files, execute steps, or know the project register. */
import { z } from 'zod'
import {
  databaseAllocationDefaults,
  databaseAllocationSchema,
} from './database-provision-schema.ts'
import { execContextSchema } from './recipe-exec-schema.ts'

const strictObject = <Shape extends z.core.$ZodLooseShape>(shape: Shape) =>
  z.strictObject(shape, { error: 'unknown-key rule: objects may not contain unknown keys' })

const provisionEntrySchema = strictObject({
  path: z
    .string()
    .min(1)
    .refine(
      (path) =>
        !(
          !path.trim() ||
          /^[\\/]/.test(path) ||
          /^[A-Za-z]:[\\/]/.test(path) ||
          path.split(/[\\/]+/).includes('..')
        ),
      { error: 'provision path must be a non-empty relative path without ..' },
    ),
  method: z.enum(['link', 'clone']),
  required: z.boolean().optional(),
})

const placeholderName = z.enum(['branch', 'name', 'base', 'seed', 'key', 'path', 'main', 'index'])

const worktreeCreateArgSchema = z.union([
  z.string(),
  strictObject({
    value: z.string(),
    omitWhenEmpty: placeholderName,
  }),
  strictObject({ expand: z.literal('seed') }),
])

const commandSchema = strictObject({
  command: z.string().min(1),
  args: z.array(worktreeCreateArgSchema),
  cwd: z.string().optional(),
})

const stepFields = {
  name: z.string().min(1),
  run: commandSchema,
  undo: commandSchema
    .describe(
      'Reverses this step. Must succeed when the step never ran or only partly ran: compensation after a failed create and teardown both run it without knowing how far creation got. Teardown uses the recipe recorded when the tree was built, never the current file; any failed undo or verifyDown keeps the tree and its claims.',
    )
    .optional(),
  verify: commandSchema.optional(),
  exec: execContextSchema.optional(),
}

const stepSchema = strictObject(stepFields)
const refreshStepSchema = stepSchema.omit({ undo: true })

const seedsSchema = strictObject({
  choices: z.array(z.string().min(1)).min(1),
  default: z.string().min(1).optional(),
  reseed: refreshStepSchema.optional(),
})

const allocationsSchema = strictObject({
  ports: z.array(z.string().min(1)).optional(),
  databases: z.record(z.string(), databaseAllocationSchema).optional(),
  strings: z
    .record(z.string(), z.string())
    .describe(
      'Named claimed string values. Templates may use only {branch} {name} {base} {key} {seed} {path} {main} {index}; include {index} when simultaneous worktrees could otherwise collide.',
    )
    .optional(),
})

const envFileSchema = strictObject({
  path: z
    .string()
    .min(1)
    .describe('Relative to the worktree root; absolute paths and .. segments are refused.'),
  contents: z
    .string()
    .describe(
      'Filled from the recipe static values, {label}, {index}, {ports.*}, {db.*}, and {alloc.*}. Secret values must never appear in errors, logs, run records, or the store.',
    ),
  mode: z
    .enum(['append', 'replace', 'managed-block'])
    .describe('Defaults to managed-block when omitted.')
    .optional(),
  inherit: z
    .string()
    .describe(
      'Optional path relative to the project root; absolute paths and .. segments are refused.',
    )
    .optional(),
  omit: z
    .array(z.string())
    .describe('Assignment keys removed from the inherited base before contents are applied.')
    .optional(),
})

const sharedSchema = strictObject({
  name: z.string().min(1).describe('Unique name for this shared declaration.'),
  kind: z.enum(['path', 'volume', 'network', 'service']),
  from: z
    .string()
    .min(1)
    .describe(
      'Existing resource owned outside this run. Paths and volumes must be relative with no .. segment; networks and services are identifiers containing no slash.',
    ),
  at: z
    .string()
    .describe(
      "Location inside the tree. Must be relative with no .. segment and defaults to from's basename. Shared entries are reported only and are never created, claimed, verified, or removed by the run.",
    )
    .optional(),
})

const composeSchema = strictObject({
  files: z.array(z.string().min(1)).min(1),
  envFile: z.string().min(1).optional(),
  wait: z.boolean().optional(),
})

const recipeShape = strictObject({
  baseRef: z.string().optional(),
  relativePaths: z
    .boolean()
    .describe(
      'Pass --relative-paths to git worktree add so Git metadata remains valid when the checkout is mounted at another root. Defaults to false.',
    )
    .optional(),
  hookBranch: z
    .string()
    .min(1)
    .superRefine((template, context) => {
      for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
        if (match[1] !== 'name') {
          context.addIssue({
            code: 'custom',
            message: `hook-branch placeholder rule: hookBranch may use only {name}, not {${match[1]}}`,
          })
        }
      }
    })
    .optional(),
  allocate: allocationsSchema.optional(),
  provision: z
    .array(provisionEntrySchema)
    .describe(
      "Dependency paths placed in the writer tree before env files and create steps. link shares the main checkout's immediate entries, so writes through a link reach the main checkout; clone makes an independent copy-on-write copy.",
    )
    .optional(),
  env: z.array(envFileSchema).optional(),
  compose: composeSchema.optional(),
  shared: z.array(sharedSchema).optional(),
  pre: z.array(stepSchema).optional(),
  create: z.array(stepSchema),
  refresh: z.array(refreshStepSchema).optional(),
  seeds: seedsSchema.optional(),
  serve: z
    .record(z.string(), z.array(stepSchema))
    .describe(
      'rule 1: every serve step "<name>" in mode "<mode>" must declare undo so teardown can stop anything the worker started.',
    )
    .optional(),
  destroy: z.array(stepSchema).optional(),
  verifyDown: z.array(stepSchema).optional(),
})

type RecipeInput = z.infer<typeof recipeShape>
type StepInput = z.infer<typeof stepSchema>
type SharedInput = z.infer<typeof sharedSchema>

const STATIC_PLACEHOLDERS = new Set([
  'branch',
  'name',
  'base',
  'seed',
  'key',
  'path',
  'main',
  'index',
  'label',
  'tree_exists',
])
const ALLOCATION_STATIC_PLACEHOLDERS = new Set(
  [...STATIC_PLACEHOLDERS].filter((name) => name !== 'label' && name !== 'tree_exists'),
)
const ALLOCATION_PLACEHOLDER = /^(ports|db|alloc)\.([^{}.]+)$/
const DATABASE_URL_PLACEHOLDER = /^db\.([^{}.]+)\.url$/
const DATABASE_URL_ENGINES = new Set(['postgres', 'mysql', 'mariadb'])

function allSteps(recipe: RecipeInput): StepInput[] {
  return [
    ...(recipe.pre ?? []),
    ...recipe.create,
    ...(recipe.refresh ?? []),
    ...(recipe.seeds?.reseed ? [recipe.seeds.reseed] : []),
    ...Object.values(recipe.serve ?? {}).flat(),
    ...(recipe.destroy ?? []),
    ...(recipe.verifyDown ?? []),
  ]
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn)
  return []
}

/** Name every recipe placeholder referenced by a step, including structured arguments. */
export function stepPlaceholders(step: unknown): { name: string; allocation: boolean }[] {
  const names = new Map<string, boolean>()
  for (const text of stringsIn(step)) {
    for (const match of text.matchAll(/\{([^{}]+)\}/g)) {
      const name = match[1]!
      const allocation = ALLOCATION_PLACEHOLDER.test(name)
      if (STATIC_PLACEHOLDERS.has(name) || allocation) names.set(name, allocation)
    }
  }
  const visitStructuredArguments = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visitStructuredArguments(entry)
      return
    }
    if (!value || typeof value !== 'object') return
    if ('omitWhenEmpty' in value && typeof value.omitWhenEmpty === 'string') {
      names.set(value.omitWhenEmpty, false)
    }
    if ('expand' in value && value.expand === 'seed') names.set('seed', false)
    for (const entry of Object.values(value)) visitStructuredArguments(entry)
  }
  visitStructuredArguments(step)
  return [...names].map(([name, allocation]) => ({ name, allocation }))
}

function databaseUrlPlaceholderRule(name: string): string {
  return `placeholder rule: {${name}} is valid only inside env[].contents for a provisioned postgres, mysql, or mariadb allocation`
}

function placeholderProblem(name: string, recipe: RecipeInput): string | null {
  if (STATIC_PLACEHOLDERS.has(name)) return null
  if (DATABASE_URL_PLACEHOLDER.test(name)) return databaseUrlPlaceholderRule(name)
  const allocation = name.match(ALLOCATION_PLACEHOLDER)
  if (!allocation) return `placeholder rule: unknown placeholder {${name}}`
  const [, kind, declaredName] = allocation
  const declared =
    kind === 'ports'
      ? recipe.allocate?.ports?.includes(declaredName!)
      : kind === 'db'
        ? Object.hasOwn(recipe.allocate?.databases ?? {}, declaredName!)
        : Object.hasOwn(recipe.allocate?.strings ?? {}, declaredName!)
  return declared
    ? null
    : `placeholder rule: {${name}} names an undeclared ${kind === 'db' ? 'database' : kind === 'alloc' ? 'string allocation' : 'port'}`
}

function envContentsPlaceholderProblem(name: string, recipe: RecipeInput): string | null {
  const key = name.match(DATABASE_URL_PLACEHOLDER)?.[1]
  if (!key) return placeholderProblem(name, recipe)
  const allocation = recipe.allocate?.databases?.[key]
  if (allocation?.provision && DATABASE_URL_ENGINES.has(allocation.engine)) return null
  return databaseUrlPlaceholderRule(name)
}

function addPlaceholderIssues(
  text: string,
  problemFor: (name: string) => string | null,
  context: z.RefinementCtx,
): void {
  for (const match of text.matchAll(/\{([^{}]+)\}/g)) {
    const problem = problemFor(match[1]!)
    if (problem) context.addIssue({ code: 'custom', message: problem })
  }
}

function hasAllocationPlaceholder(value: unknown): boolean {
  return stringsIn(value).some((text) =>
    [...text.matchAll(/\{([^{}]+)\}/g)].some((match) => ALLOCATION_PLACEHOLDER.test(match[1]!)),
  )
}

function validateStepNames(recipe: RecipeInput, context: z.RefinementCtx): void {
  const names = new Set<string>()
  for (const step of allSteps(recipe)) {
    if (names.has(step.name)) {
      context.addIssue({
        code: 'custom',
        message: `step-name rule: duplicate step name "${step.name}" within recipe`,
      })
    }
    names.add(step.name)
  }
}

function validateSeedDefault(recipe: RecipeInput, context: z.RefinementCtx): void {
  const declared = recipe.seeds
  if (declared?.default === undefined || declared.choices.includes(declared.default)) return
  context.addIssue({
    code: 'custom',
    path: ['seeds', 'default'],
    message: 'seed default rule: default must be one of seeds.choices',
  })
}

function validatePlaceholders(recipe: RecipeInput, context: z.RefinementCtx): void {
  const withoutEnvContents = {
    ...recipe,
    env: recipe.env?.map((envFile) => ({ ...envFile, contents: '' })),
  }
  for (const text of stringsIn(withoutEnvContents)) {
    addPlaceholderIssues(text, (name) => placeholderProblem(name, recipe), context)
  }
  for (const envFile of recipe.env ?? []) {
    addPlaceholderIssues(
      envFile.contents,
      (name) => envContentsPlaceholderProblem(name, recipe),
      context,
    )
  }
}

function validateAllocationTemplate(
  allocation: 'string' | 'database',
  name: string,
  template: string,
  context: z.RefinementCtx,
): void {
  const invalid = [...template.matchAll(/\{([^{}]+)\}/g)].some(
    (match) => !ALLOCATION_STATIC_PLACEHOLDERS.has(match[1]!),
  )
  if (invalid) {
    context.addIssue({
      code: 'custom',
      path: ['allocate', allocation === 'string' ? 'strings' : 'databases', name],
      message: `placeholder rule: ${allocation} allocation "${name}" may use only {branch} {name} {base} {key} {seed} {path} {main} {index}`,
    })
  }
}

function validateStringAllocationTemplates(recipe: RecipeInput, context: z.RefinementCtx): void {
  for (const [name, template] of Object.entries(recipe.allocate?.strings ?? {})) {
    validateAllocationTemplate('string', name, template, context)
  }
  for (const [name, allocation] of Object.entries(recipe.allocate?.databases ?? {})) {
    validateAllocationTemplate('database', name, allocation.name, context)
  }
}

function validateAllocationUndo(recipe: RecipeInput, context: z.RefinementCtx): void {
  for (const [index, step] of recipe.create.entries()) {
    if (hasAllocationPlaceholder(step.run) && !step.undo) {
      context.addIssue({
        code: 'custom',
        path: ['create', index],
        message: `rule 1: create step "${step.name}" references an allocation placeholder and must declare undo`,
      })
    }
  }
}

export function allocationEnvironmentVariable(
  kind: 'ports' | 'db' | 'alloc',
  name: string,
): string {
  const normalized = name.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  const family = kind === 'ports' ? 'PORTS' : kind === 'db' ? 'DB' : 'ALLOC'
  return `ORCH_${family}_${normalized}`
}

function validateServeUndo(recipe: RecipeInput, context: z.RefinementCtx): void {
  for (const [mode, steps] of Object.entries(recipe.serve ?? {})) {
    for (const [index, step] of steps.entries()) {
      if (!step.undo) {
        context.addIssue({
          code: 'custom',
          path: ['serve', mode, index],
          message: `rule 1: serve step "${step.name}" in mode "${mode}" must declare undo`,
        })
      }
    }
  }
}

function validateAllocationEnvironmentNames(recipe: RecipeInput, context: z.RefinementCtx): void {
  const allocations: ['ports' | 'db' | 'alloc', string][] = [
    ...(recipe.allocate?.ports ?? []).map((name): ['ports', string] => ['ports', name]),
    ...Object.keys(recipe.allocate?.databases ?? {}).map((name): ['db', string] => ['db', name]),
    ...Object.keys(recipe.allocate?.strings ?? {}).map((name): ['alloc', string] => [
      'alloc',
      name,
    ]),
  ]
  const names = new Map<string, string>()
  for (const [kind, name] of allocations) {
    const variable = allocationEnvironmentVariable(kind, name)
    const prior = names.get(variable)
    if (prior !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['allocate', kind === 'ports' ? 'ports' : kind === 'db' ? 'databases' : 'strings'],
        message: `allocation names "${prior}" and "${name}" map to the same environment variable ${variable}`,
      })
    } else {
      names.set(variable, name)
    }
  }
}

function validateWorkingDirectories(recipe: RecipeInput, context: z.RefinementCtx): void {
  for (const step of allSteps(recipe)) {
    if (
      step.exec?.where === 'container' &&
      [step.run, step.undo, step.verify].some((command) => command?.cwd !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: `cwd rule: step "${step.name}" runs in a container, where cwd is not supported`,
      })
    }
    if (step.run.cwd !== undefined) validateCwd(step.run.cwd, step.name, 'run', context)
    if (step.undo?.cwd !== undefined) validateCwd(step.undo.cwd, step.name, 'undo', context)
    if (step.verify?.cwd !== undefined) validateCwd(step.verify.cwd, step.name, 'verify', context)
  }
}

function validateRelativePath(
  path: string,
  field: 'path' | 'inherit',
  context: z.RefinementCtx,
): void {
  const absolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
  const parent = path.split(/[\\/]+/).includes('..')
  if (absolute || parent) {
    context.addIssue({
      code: 'custom',
      path: ['env'],
      message: `env-file ${field} rule: ${field} must be relative to the ${field === 'path' ? 'tree' : 'project'} root and contain no .. segment`,
    })
  }
}

function validateEnvPaths(recipe: RecipeInput, context: z.RefinementCtx): void {
  for (const envFile of recipe.env ?? []) {
    validateRelativePath(envFile.path, 'path', context)
    if (envFile.inherit !== undefined) validateRelativePath(envFile.inherit, 'inherit', context)
  }
}

function validateComposePaths(recipe: RecipeInput, context: z.RefinementCtx): void {
  if (!recipe.compose) return
  for (const [index, path] of recipe.compose.files.entries()) {
    if (!isAbsoluteOrParentPath(path)) continue
    context.addIssue({
      code: 'custom',
      path: ['compose', 'files', index],
      message:
        'compose file rule: files must be relative to the tree root and contain no .. segment',
    })
  }
  if (recipe.compose.envFile && isAbsoluteOrParentPath(recipe.compose.envFile)) {
    context.addIssue({
      code: 'custom',
      path: ['compose', 'envFile'],
      message:
        'compose env-file rule: envFile must be relative to the tree root and contain no .. segment',
    })
  }
}

function validateProvisionPaths(recipe: RecipeInput, context: z.RefinementCtx): void {
  const paths = new Set<string>()
  for (const [index, entry] of (recipe.provision ?? []).entries()) {
    if (paths.has(entry.path)) {
      context.addIssue({
        code: 'custom',
        path: ['provision', index, 'path'],
        message: `provision path must be unique: "${entry.path}"`,
      })
    }
    paths.add(entry.path)
  }
}

function isAbsoluteOrParentPath(path: string): boolean {
  return /^[\\/]/.test(path) || /^[A-Za-z]:[\\/]/.test(path) || path.split(/[\\/]+/).includes('..')
}

function sharedTarget(entry: SharedInput): string {
  if (entry.at !== undefined) return entry.at
  const segments = entry.from.split(/[\\/]+/).filter(Boolean)
  return segments.at(-1) ?? entry.from
}

function validateSharedSource(entry: SharedInput, index: number, context: z.RefinementCtx): void {
  const pathKind = entry.kind === 'path' || entry.kind === 'volume'
  if (!(pathKind ? isAbsoluteOrParentPath(entry.from) : entry.from.includes('/'))) return
  context.addIssue({
    code: 'custom',
    path: ['shared', index, 'from'],
    message: pathKind
      ? `shared from rule: ${entry.kind} "${entry.name}" must be relative and contain no .. segment`
      : `shared from rule: ${entry.kind} "${entry.name}" must be an identifier containing no slash`,
  })
}

function validateShared(recipe: RecipeInput, context: z.RefinementCtx): void {
  const names = new Set<string>()
  const targets = new Map<string, string>()
  const envPaths = new Set((recipe.env ?? []).map((envFile) => envFile.path))
  for (const [index, entry] of (recipe.shared ?? []).entries()) {
    if (names.has(entry.name)) {
      context.addIssue({
        code: 'custom',
        path: ['shared', index, 'name'],
        message: `shared-name rule: duplicate shared name "${entry.name}" within recipe`,
      })
    }
    names.add(entry.name)
    validateSharedSource(entry, index, context)
    const target = sharedTarget(entry)
    if (isAbsoluteOrParentPath(target)) {
      context.addIssue({
        code: 'custom',
        path: ['shared', index, 'at'],
        message: `shared at rule: shared "${entry.name}" at "${target}" must be relative to the tree root and contain no .. segment`,
      })
    }
    const prior = targets.get(target)
    if (prior !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['shared', index, 'at'],
        message: `shared at rule: shared "${prior}" and shared "${entry.name}" both declare at "${target}"`,
      })
    } else {
      targets.set(target, entry.name)
    }
    if (envPaths.has(target)) {
      context.addIssue({
        code: 'custom',
        path: ['shared', index, 'at'],
        message: `shared at rule: shared "${entry.name}" at "${target}" collides with env path "${target}"`,
      })
    }
  }
}

const validatedRecipeSchema = recipeShape.superRefine((recipe, context) => {
  validateSeedDefault(recipe, context)
  validateStepNames(recipe, context)
  validatePlaceholders(recipe, context)
  validateStringAllocationTemplates(recipe, context)
  validateAllocationUndo(recipe, context)
  validateServeUndo(recipe, context)
  validateAllocationEnvironmentNames(recipe, context)
  validateWorkingDirectories(recipe, context)
  validateEnvPaths(recipe, context)
  validateComposePaths(recipe, context)
  validateProvisionPaths(recipe, context)
  validateShared(recipe, context)
})

export const recipeSchema = validatedRecipeSchema.transform((recipe) => ({
  ...recipe,
  ...(recipe.compose === undefined
    ? {}
    : { compose: { ...recipe.compose, wait: recipe.compose.wait ?? true } }),
  ...(recipe.allocate?.databases === undefined
    ? {}
    : {
        allocate: {
          ...recipe.allocate,
          databases: databaseAllocationDefaults(recipe.allocate.databases),
        },
      }),
  ...(recipe.provision === undefined
    ? {}
    : {
        provision: recipe.provision.map((entry) => ({
          ...entry,
          required: entry.required ?? false,
        })),
      }),
  ...(recipe.shared === undefined
    ? {}
    : { shared: recipe.shared.map((entry) => ({ ...entry, at: sharedTarget(entry) })) }),
}))

export const configDocumentSchema = strictObject({
  $schema: z.string().describe('Path or URL of this JSON Schema, for editors.').optional(),
  worktree: recipeSchema.optional(),
})

const configDocumentJsonSchema = strictObject({
  $schema: z.string().describe('Path or URL of this JSON Schema, for editors.').optional(),
  worktree: validatedRecipeSchema.optional(),
})

function validateCwd(
  cwd: string,
  stepName: string,
  commandName: string,
  context: z.RefinementCtx,
): void {
  const absolute = cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cwd)
  const parent = cwd.split(/[\\/]+/).includes('..')
  if (absolute || parent) {
    context.addIssue({
      code: 'custom',
      message: `cwd rule: ${commandName} cwd for step "${stepName}" must be relative to the tree root and contain no .. segment`,
    })
  }
}

export type TrackedRecipe = z.infer<typeof recipeSchema>

/** Fill the validated hook-only branch template. */
export function hookBranchName(template: string | undefined, name: string): string {
  return (template ?? 'worktree-{name}').replace(/\{name\}/g, name)
}

export function recipeJsonSchema(): unknown {
  return z.toJSONSchema(configDocumentJsonSchema, { target: 'draft-2020-12' })
}
