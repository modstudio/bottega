// concern: record-api-context-items
/** Validates and routes hosted context-item writes. */
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { CONTEXT_HOLDER_KINDS, CONTEXT_ITEM_KINDS } from '../../../shared/context-item-vocabulary.ts'
import type { RecordIdentity } from './record-auth.ts'
import type { RecordContextItemInput } from './record-context-items.ts'

type Environment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }
type Deps = {
  upsertContextItem(input: Tenant & RecordContextItemInput): Promise<unknown>
  deleteContextItem(
    input: Tenant & { id: string; expectedRevision?: string },
  ): Promise<{ removed: boolean }>
}

const body = z.object({
  id: z.string().uuid().optional(),
  holderKind: z.enum(CONTEXT_HOLDER_KINDS),
  holderId: z.string().min(1),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .max(64),
  kind: z.enum(CONTEXT_ITEM_KINDS),
  body: z.string(),
  source: z.string().trim().min(1),
  questionNumber: z.number().int().nullable(),
  target: z.string().nullable(),
  expectedRevision: z.string().optional(),
})

export function registerRecordContextItemRoutes(
  app: Hono<Environment>,
  deps: Deps,
  ports: {
    scope(context: Context<Environment>): Tenant | null
    noSpace(context: Context<Environment>): Response
  },
) {
  app.put('/v1/context-items', async (context) => {
    const tenant = ports.scope(context)
    if (!tenant) return ports.noSpace(context)
    const parsed = body.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return context.json({ error: 'invalid context item' }, 400)
    return context.json(await deps.upsertContextItem({ ...tenant, ...parsed.data }))
  })
  app.delete('/v1/context-items/:id', async (context) => {
    const tenant = ports.scope(context)
    if (!tenant) return ports.noSpace(context)
    const parsed = z.string().uuid().safeParse(context.req.param('id'))
    const request = z
      .object({ expectedRevision: z.string().optional() })
      .safeParse(await context.req.json().catch(() => ({})))
    if (!parsed.success || !request.success)
      return context.json({ error: 'invalid context item delete' }, 400)
    const result = await deps.deleteContextItem({ ...tenant, id: parsed.data, ...request.data })
    return result.removed
      ? context.json(result)
      : context.json({ error: `context item ${parsed.data} not found` }, 404)
  })
}
