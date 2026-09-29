// concern: record-api-settings
/** Owns the hosted settings JSON route. Must not know SQL or local execution. */
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { RecordIdentity } from './record-auth.ts'
import type {
  RecordSettingsPermissionInput,
  RecordSettingsPermissionResult,
} from './record-settings.ts'

type ApiEnvironment = { Variables: { identity: RecordIdentity } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }

const bodySchema = z
  .object({
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('user') }).strict(),
      z.object({ kind: z.literal('project'), project: z.string().trim().min(1) }).strict(),
    ]),
    list: z.enum(['allow', 'ask', 'deny']),
    rule: z.string().trim().min(1),
    operation: z.enum(['add', 'remove']),
    reason: z.string().trim().min(1),
    expectedRevision: z.string().uuid(),
  })
  .strict()

export function registerRecordSettingsRoutes(
  app: Hono<ApiEnvironment>,
  deps: {
    applySettingsPermission(
      input: RecordSettingsPermissionInput,
    ): Promise<RecordSettingsPermissionResult>
  },
  ports: {
    scope(context: Context<ApiEnvironment>): Tenant | null
    noSpace(context: Context<ApiEnvironment>): Response
    writeError(context: Context<ApiEnvironment>, error: unknown): Response
  },
): void {
  app.post('/v1/settings/permission', async (context) => {
    const tenant = ports.scope(context)
    if (!tenant) return ports.noSpace(context)
    const body = bodySchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid settings permission edit' }, 400)
    try {
      return context.json(await deps.applySettingsPermission({ ...tenant, ...body.data }))
    } catch (error) {
      return ports.writeError(context, error)
    }
  })
}
