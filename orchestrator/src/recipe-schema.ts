// concern: tracked worktree recipe schema
/** Knows only the stored recipe grammar and its refusal rules. Must not read files, execute steps, or know the project register. */
import { z } from 'zod'

const strictObject = <Shape extends z.core.$ZodLooseShape>(shape: Shape) =>
  z.strictObject(shape, { error: 'unknown-key rule: objects may not contain unknown keys' })

const placeholderName = z.enum(['branch', 'name', 'base', 'seed', 'key', 'path'])

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

const databaseProviderSchema = z.discriminatedUnion('kind', [
  strictObject({
    kind: z.literal('postgres-template'),
    template: z.string().min(1),
    psql: z.string().min(1).optional(),
  }),
  strictObject({
    kind: z.literal('mysql-dump'),
    dump: z.string().min(1),
    mysql: z.string().min(1).optional(),
  }),
  strictObject({
    kind: z.literal('compose'),
    up: z.string().min(1),
    down: z.string().min(1),
  }),
])

export const allocationsSchema = strictObject({
  ports: z.array(z.string().min(1)).optional(),
  databases: z.record(z.string(), databaseProviderSchema).optional(),
  strings: z.record(z.string(), z.string()).optional(),
})

export const envFileSchema = strictObject({
  path: z.string().min(1),
  contents: z.string(),
  mode: z.enum(['append', 'replace', 'managed-block']).optional(),
  inherit: z.string().optional(),
  omit: z.array(z.string()).optional(),
})

export const sharedSchema = strictObject({
  name: z.string().min(1),
  kind: z.enum(['path', 'volume', 'network', 'service']),
  from: z.string().min(1),
  at: z.string().optional(),
})

const recipeShape = strictObject({
  baseRef: z.string().optional(),
  allocate: allocationsSchema.optional(),
  env: z.array(envFileSchema).optional(),
  shared: z.array(sharedSchema).optional(),
  pre: z.array(stepSchema).optional(),
  create: z.array(stepSchema),
  serve: z.record(z.string(), z.array(stepSchema)).optional(),
  destroy: z.array(stepSchema).optional(),
  verifyDown: z.array(stepSchema).optional(),
})

type RecipeInput = z.infer<typeof recipeShape>
type StepInput = z.infer<typeof stepSchema>

const STATIC_PLACEHOLDERS = new Set([
  'branch',
  'name',
  'base',
  'seed',
  'key',
  'path',
  'main',
  'index',
])
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

export const recipeSchema = recipeShape.superRefine((recipe, context) => {
  validateStepNames(recipe, context)
  validatePlaceholders(recipe, context)
  validateAllocationUndo(recipe, context)
  validateWorkingDirectories(recipe, context)
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

export function recipeJsonSchema(): unknown {
  return z.toJSONSchema(recipeSchema, { target: 'draft-2020-12' })
}
