// concern: built-in database provision recipe schema
/** Knows only the database allocation grammar. Must not read secrets or execute clients. */
import { z } from 'zod'
import { databaseNameProblem, relativeDatabasePath } from './database-identity.ts'
import { execContextSchema } from './recipe-exec-schema.ts'

const strictObject = <Shape extends z.core.$ZodLooseShape>(shape: Shape) =>
  z.strictObject(shape, { error: 'unknown-key rule: objects may not contain unknown keys' })

const relativePath = z
  .string()
  .min(1)
  .refine(relativeDatabasePath, {
    error: 'database provision path must be relative and contain no .. segment',
  })

const connectionSchema = strictObject({
  key: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'database connection key must be an env key name'),
  file: relativePath.optional(),
})

const provisionSchema = strictObject({
  from: z.string().min(1),
  connection: connectionSchema,
  reuse: z.boolean().optional(),
  exec: execContextSchema.optional(),
})

export const databaseAllocationSchema = strictObject({
  engine: z.enum(['postgres', 'mysql', 'mariadb', 'sqlite', 'other']),
  name: z
    .string()
    .min(1)
    .describe(
      'Claimed database name. Templates may use only {branch} {name} {base} {key} {seed} {path} {main} {index}; include {index} when simultaneous worktrees could otherwise collide.',
    ),
  provision: provisionSchema.optional(),
}).superRefine((allocation, context) => {
  if (allocation.engine === 'other' && allocation.provision) {
    context.addIssue({
      code: 'custom',
      path: ['provision'],
      message:
        'database engine "other" cannot use built-in provision; add a project create step with undo and verifyDown',
    })
  }
  if (allocation.engine !== 'other') {
    const template = allocation.name.replace(/\{[^{}]+\}/g, 'x')
    const problem = databaseNameProblem(allocation.engine, template)
    if (problem) context.addIssue({ code: 'custom', path: ['name'], message: problem })
    if (allocation.provision) {
      const source = allocation.provision.from.replace(/\{[^{}]+\}/g, 'x')
      const sourceProblem =
        allocation.engine === 'sqlite'
          ? relativeDatabasePath(source)
            ? null
            : 'sqlite source must be relative to the project root with no .. segment'
          : databaseNameProblem(allocation.engine, source)
      if (sourceProblem)
        context.addIssue({ code: 'custom', path: ['provision', 'from'], message: sourceProblem })
    }
  }
})

export function databaseAllocationDefaults(
  databases: Record<string, z.infer<typeof databaseAllocationSchema>>,
) {
  return Object.fromEntries(
    Object.entries(databases).map(([name, allocation]) => [
      name,
      allocation.provision
        ? {
            ...allocation,
            provision: {
              ...allocation.provision,
              connection: {
                ...allocation.provision.connection,
                file: allocation.provision.connection.file ?? '.env',
              },
              reuse: allocation.provision.reuse ?? false,
            },
          }
        : allocation,
    ]),
  )
}
