// concern: record-api-context-items
/** Validates and routes hosted context-item reads and writes. */
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import {
  CONTEXT_HOLDER_KINDS,
  CONTEXT_ITEM_KINDS,
  type ContextItemHolderGroup,
  splitContextHolder,
} from '../../../shared/context-item-vocabulary.ts'
import { maskHostedWrite } from '../../../shared/hosted-secret-mask.ts'
import {
  CONTEXT_ITEM_HOLDER_BATCH_LIMIT,
  RECORD_CONTEXT_ITEM_HOLDERS_ROUTE,
  RECORD_CONTEXT_ITEMS_ROUTE,
} from './record-api-client-paths.ts'
import type { RecordIdentity } from './record-auth.ts'
import type { RecordContextItem, RecordContextItemInput } from './record-context-items.ts'

type Environment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }
type Deps = {
  readContextItems(
    input: Tenant & {
      holders: Array<{ holderKind: (typeof CONTEXT_HOLDER_KINDS)[number]; holderId: string }>
      slug?: string
    },
  ): Promise<RecordContextItem[]>
  readContextHolders(
    input: Tenant & { holderKind: (typeof CONTEXT_HOLDER_KINDS)[number] },
  ): Promise<ContextItemHolderGroup[]>
  upsertContextItem(input: Tenant & RecordContextItemInput): Promise<unknown>
  deleteContextItem(
    input: Tenant & { id: string; expectedRevision?: string },
  ): Promise<{ removed: boolean }>
}

const holder = z.string().transform((value, context) => {
  try {
    return splitContextHolder(value)
  } catch {
    context.addIssue({ code: 'custom', message: 'invalid context holder' })
    return z.NEVER
  }
})

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
  app.get(RECORD_CONTEXT_ITEM_HOLDERS_ROUTE, async (context) => {
    const tenant = ports.scope(context)
    if (!tenant) return ports.noSpace(context)
    const parsed = z.enum(CONTEXT_HOLDER_KINDS).safeParse(context.req.query('kind'))
    if (!parsed.success) return context.json({ error: 'invalid context holder kind' }, 400)
    return context.json(await deps.readContextHolders({ ...tenant, holderKind: parsed.data }))
  })
  app.get(RECORD_CONTEXT_ITEMS_ROUTE, async (context) => {
    const tenant = ports.scope(context)
    if (!tenant) return ports.noSpace(context)
    const holders = z.array(holder).min(1).safeParse(context.req.queries('holder'))
    const slug = z.string().min(1).optional().safeParse(context.req.query('slug'))
    if (!holders.success || !slug.success)
      return context.json({ error: 'invalid context item query' }, 400)
    if (holders.data.length > CONTEXT_ITEM_HOLDER_BATCH_LIMIT)
      return context.json(
        {
          error: `holder count exceeds CONTEXT_ITEM_HOLDER_BATCH_LIMIT (${CONTEXT_ITEM_HOLDER_BATCH_LIMIT})`,
        },
        400,
      )
    if (slug.data && holders.data.length !== 1)
      return context.json({ error: 'slug requires exactly one holder' }, 400)
    return context.json(
      await deps.readContextItems({
        ...tenant,
        holders: holders.data,
        ...(slug.data ? { slug: slug.data } : {}),
      }),
    )
  })
  app.put(RECORD_CONTEXT_ITEMS_ROUTE, async (context) => {
    const tenant = ports.scope(context)
    if (!tenant) return ports.noSpace(context)
    const parsed = body.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return context.json({ error: 'invalid context item' }, 400)
    return context.json(
      await deps.upsertContextItem({
        ...tenant,
        ...maskHostedWrite('record.context-item.put', parsed.data),
      }),
    )
  })
  app.delete(`${RECORD_CONTEXT_ITEMS_ROUTE}/:id`, async (context) => {
    const tenant = ports.scope(context)
    if (!tenant) return ports.noSpace(context)
    const parsed = z.string().uuid().safeParse(context.req.param('id'))
    const request = z
      .object({ expectedRevision: z.string().optional() })
      .safeParse(await context.req.json().catch(() => ({})))
    if (!parsed.success || !request.success)
      return context.json({ error: 'invalid context item delete' }, 400)
    const result = await deps.deleteContextItem({ ...tenant, id: parsed.data, ...request.data })
    return context.json(result)
  })
}
