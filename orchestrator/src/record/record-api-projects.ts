// concern: record-api-projects
/** Hosted project HTTP routes. Must not know SQL or local execution. */
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { RecordIdentity } from './record-auth.ts'
import type { RecordProject, RecordProjectUpsertInput } from './record-projects.ts'

type ApiEnvironment = { Variables: { identity: RecordIdentity } }
type Tenant = {
  url: string
  userId: string
  spaceId: string
  spaceIds: string[]
}

const projectUpsertSchema = z.object({
  name: z.string().trim().min(1),
  previousName: z.string().trim().min(1).optional(),
  path: z.string().min(1),
  stack: z.string().nullable(),
  canon: z.boolean(),
  settings: z.record(z.string(), z.unknown()),
  retiredAt: z.string().datetime({ offset: true }).nullable(),
})

export function registerRecordProjectRoutes(
  app: Hono<ApiEnvironment>,
  deps: {
    readProjects(input: Tenant): Promise<RecordProject[]>
    upsertProject(input: Tenant & RecordProjectUpsertInput): Promise<{ name: string }>
    retireProject(input: Tenant & { name: string }): Promise<{ name: string }>
  },
  helpers: {
    scope(context: Context<ApiEnvironment>): Tenant | null
    noSpace(context: Context<ApiEnvironment>): Response
    writeError(context: Context<ApiEnvironment>, error: unknown): Response | Promise<Response>
  },
): void {
  app.get('/v1/projects', async (context) => {
    const tenant = helpers.scope(context)
    return tenant ? context.json(await deps.readProjects(tenant)) : helpers.noSpace(context)
  })
  app.put('/v1/projects', async (context) => {
    const tenant = helpers.scope(context)
    if (!tenant) return helpers.noSpace(context)
    const body = projectUpsertSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid project upsert' }, 400)
    try {
      return context.json(await deps.upsertProject({ ...tenant, ...body.data }))
    } catch (error) {
      return helpers.writeError(context, error)
    }
  })
  app.post('/v1/projects/:name/retire', async (context) => {
    const tenant = helpers.scope(context)
    if (!tenant) return helpers.noSpace(context)
    const name = z.string().trim().min(1).safeParse(context.req.param('name'))
    if (!name.success) return context.json({ error: 'project name is required' }, 400)
    try {
      return context.json(await deps.retireProject({ ...tenant, name: name.data }))
    } catch (error) {
      return helpers.writeError(context, error)
    }
  })
}
