// concern: tracked worktree recipe schema
/** Knows only the stored recipe grammar and its refusal rules. Must not read files, execute steps, or know the project register. */
import { z } from 'zod'

const strictObject = <Shape extends z.core.$ZodLooseShape>(shape: Shape) =>
  z.strictObject(shape, { error: 'unknown-key rule: objects may not contain unknown keys' })

const placeholderName = z.enum(['branch', 'name', 'base', 'seed', 'key', 'path', 'main', 'index'])

const worktreeCreateArgSchema = z.union([
  z.string(),
  strictObject({
    value: z.string(),
    omitWhenEmpty: placeholderName,
  }),
  strictObject({ expand: z.literal('seed') }),
])

export const commandSchema = strictObject({
  command: z.string().min(1),
  args: z.array(worktreeCreateArgSchema),
  cwd: z.string().optional(),
})

export const execContextSchema = z.discriminatedUnion('where', [
  strictObject({ where: z.literal('host') }),
  strictObject({ where: z.literal('container'), service: z.string().min(1) }),
  strictObject({ where: z.literal('as-user'), user: z.string().min(1) }),
])

export const stepSchema = strictObject({
  name: z.string().min(1),
  run: commandSchema,
  undo: commandSchema
    .describe(
      'Reverses this step. Must succeed when the step never ran or only partly ran: compensation after a failed create and teardown both run it without knowing how far creation got. Teardown uses the recipe recorded when the tree was built, never the current file; any failed undo or verifyDown keeps the tree and its claims.',
    )
    .optional(),
  verify: commandSchema.optional(),
  exec: execContextSchema.optional(),
})

export const databaseAllocationSchema = strictObject({
  engine: z.enum(['postgres', 'mysql', 'mariadb', 'sqlite', 'other']),
  name: z
    .string()
    .min(1)
    .describe(
      'Claimed database name. Templates may use only {branch} {name} {base} {key} {seed} {path} {main} {index}; include {index} when simultaneous worktrees could otherwise collide. The project create step makes the database and its undo drops it.',
    ),
})

export const allocationsSchema = strictObject({
  ports: z.array(z.string().min(1)).optional(),
  databases: z.record(z.string(), databaseAllocationSchema).optional(),
  strings: z
    .record(z.string(), z.string())
    .describe(
      'Named claimed string values. Templates may use only {branch} {name} {base} {key} {seed} {path} {main} {index}; include {index} when simultaneous worktrees could otherwise collide.',
    )
    .optional(),
})

export const envFileSchema = strictObject({
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

export const sharedSchema = strictObject({
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

const recipeShape = strictObject({
  baseRef: z.string().optional(),
  allocate: allocationsSchema.optional(),
  env: z.array(envFileSchema).optional(),
  shared: z.array(sharedSchema).optional(),
  pre: z.array(stepSchema).optional(),
  create: z.array(stepSchema),
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
])
const ALLOCATION_STATIC_PLACEHOLDERS = new Set(
  [...STATIC_PLACEHOLDERS].filter((name) => name !== 'label'),
)
const ALLOCATION_PLACEHOLDER = /^(ports|db|alloc)\.([^{}.]+)$/

function allSteps(recipe: RecipeInput): StepInput[] {
  return [
    ...(recipe.pre ?? []),
    ...recipe.create,
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

function placeholderProblem(name: string, recipe: RecipeInput): string | null {
  if (STATIC_PLACEHOLDERS.has(name)) return null
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

function validatePlaceholders(recipe: RecipeInput, context: z.RefinementCtx): void {
  for (const text of stringsIn(recipe)) {
    for (const match of text.matchAll(/\{([^{}]+)\}/g)) {
      const problem = placeholderProblem(match[1]!, recipe)
      if (problem) context.addIssue({ code: 'custom', message: problem })
    }
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
  validateStepNames(recipe, context)
  validatePlaceholders(recipe, context)
  validateStringAllocationTemplates(recipe, context)
  validateAllocationUndo(recipe, context)
  validateServeUndo(recipe, context)
  validateAllocationEnvironmentNames(recipe, context)
  validateWorkingDirectories(recipe, context)
  validateEnvPaths(recipe, context)
  validateShared(recipe, context)
})

export const recipeSchema = validatedRecipeSchema.transform((recipe) => ({
  ...recipe,
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

export type ProjectConfigDocument = z.infer<typeof configDocumentSchema>

export function recipeJsonSchema(): unknown {
  return z.toJSONSchema(configDocumentJsonSchema, { target: 'draft-2020-12' })
}
