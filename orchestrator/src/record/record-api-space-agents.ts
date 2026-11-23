// concern: record-api-space-agents
/** Validates and routes hosted space-agent reads and writes. */
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { RECORD_SPACE_AGENTS_ROUTE } from './record-api-client-paths.ts'
import type { RecordIdentity } from './record-auth.ts'
import type { RecordSpaceAgent } from './record-space-agents.ts'

type Environment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }
type Deps = {
  readSpaceAgents(input: Tenant): Promise<RecordSpaceAgent[]>
  upsertSpaceAgent(input: Tenant & RecordSpaceAgent): Promise<RecordSpaceAgent>
  deleteSpaceAgent(input: Tenant & { name: string }): Promise<{ removed: boolean }>
}

const body = z.strictObject({
  name: z.string().trim().min(1),
  harness: z.string().min(1),
  backend: z.string().min(1),
  model: z.string().min(1),
  baseUrl: z.string().nullable(),
  transport: z.string().min(1),
  provider: z.string().nullable(),
  apiKeySecret: z.string().nullable(),
  requestSettings: z.unknown().nullable(),
  jobs: z.unknown().nullable(),
  preferredJobs: z.unknown().nullable(),
  maxConcurrent: z.number().int().positive().nullable(),
  routeMetered: z.boolean(),
  trainsOnInputs: z.boolean(),
  operatedBy: z.string().min(1),
  billing: z.string().min(1),
})

export function registerRecordSpaceAgentRoutes(
  app: Hono<Environment>,
  deps: Deps,
  ports: {
    scope(context: Context<Environment>): Tenant | null
    noSpace(context: Context<Environment>): Response
  },
) {
  app.get(RECORD_SPACE_AGENTS_ROUTE, async (context) => {
    const tenant = ports.scope(context)
    return tenant ? context.json(await deps.readSpaceAgents(tenant)) : ports.noSpace(context)
  })
  app.put(RECORD_SPACE_AGENTS_ROUTE, async (context) => {
    const tenant = ports.scope(context)
    if (!tenant) return ports.noSpace(context)
    const parsed = body.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return context.json({ error: 'invalid space agent declaration' }, 400)
    return context.json(await deps.upsertSpaceAgent({ ...tenant, ...parsed.data }))
  })
  app.delete(RECORD_SPACE_AGENTS_ROUTE, async (context) => {
    const tenant = ports.scope(context)
    if (!tenant) return ports.noSpace(context)
    const parsed = z
      .object({ name: z.string().trim().min(1) })
      .safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return context.json({ error: 'invalid space agent delete' }, 400)
    return context.json(await deps.deleteSpaceAgent({ ...tenant, ...parsed.data }))
  })
}
