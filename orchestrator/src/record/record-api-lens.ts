// concern: record-api-lens
/** Exposes validated tenant-bound lens catalogue routes. */
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import {
  recordLensProfileUpsertSchema,
  recordLensTableSchema,
  recordLensUpsertSchema,
  recordProjectLensSelectionSchema,
} from './record-api-lens-schemas.ts'
import type { RecordIdentity } from './record-auth.ts'
import { decodeRecordCursor, pageRecordItems } from './record-cursor.ts'
import {
  type listRecordLensCatalogue,
  RecordLensError,
  type selectRecordProjectLensProfile,
  type upsertRecordLens,
  type upsertRecordLensProfile,
} from './record-lens-catalogue.ts'

type Environment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }
export type RecordLensRouteDeps = {
  listLensCatalogue: typeof listRecordLensCatalogue
  upsertLens: typeof upsertRecordLens
  upsertLensProfile: typeof upsertRecordLensProfile
  selectProjectLensProfile: typeof selectRecordProjectLensProfile
}
type Ports = {
  scope(context: Context<Environment>): Tenant | null
  noSpace(context: Context<Environment>): Response
}
const limit = z.coerce.number().int().min(1).max(100).default(20)

export function registerRecordLensRoutes(
  app: Hono<Environment>,
  deps: RecordLensRouteDeps,
  ports: Ports,
): void {
  const failure = (context: Context<Environment>, error: unknown) =>
    error instanceof RecordLensError
      ? context.json({ error: error.message }, error.status as 404 | 409)
      : (() => {
          throw error
        })()
  app.get('/v1/lens-catalogue/:table', async (context) => {
    const active = ports.scope(context)
    if (!active) return ports.noSpace(context)
    const table = recordLensTableSchema.safeParse(context.req.param('table'))
    const query = z.object({ limit, cursor: z.string().optional() }).safeParse(context.req.query())
    if (!table.success || !query.success)
      return context.json({ error: 'invalid lens catalogue list request' }, 400)
    let cursor = null
    try {
      cursor = query.data.cursor ? decodeRecordCursor(query.data.cursor) : null
    } catch {
      return context.json({ error: 'invalid cursor' }, 400)
    }
    const items = await deps.listLensCatalogue({
      ...active,
      table: table.data,
      limit: query.data.limit,
      cursor,
    })
    return context.json(
      pageRecordItems(
        items,
        query.data.limit,
        (item) => ({
          at: String(item[table.data.includes('revision') ? 'at' : 'updatedAt']),
          id: String(item.id),
        }),
        true,
      ),
    )
  })
  app.put('/v1/lens-catalogue/lenses', async (context) => {
    const active = ports.scope(context)
    if (!active) return ports.noSpace(context)
    const body = recordLensUpsertSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid lens upsert' }, 400)
    try {
      return context.json(await deps.upsertLens({ ...active, ...body.data }))
    } catch (error) {
      return failure(context, error)
    }
  })
  app.put('/v1/lens-catalogue/profiles', async (context) => {
    const active = ports.scope(context)
    if (!active) return ports.noSpace(context)
    const body = recordLensProfileUpsertSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid lens profile upsert' }, 400)
    try {
      return context.json(await deps.upsertLensProfile({ ...active, ...body.data }))
    } catch (error) {
      return failure(context, error)
    }
  })
  app.put('/v1/lens-catalogue/selections', async (context) => {
    const active = ports.scope(context)
    if (!active) return ports.noSpace(context)
    const body = recordProjectLensSelectionSchema.safeParse(
      await context.req.json().catch(() => null),
    )
    if (!body.success) return context.json({ error: 'invalid project lens selection' }, 400)
    try {
      return context.json(await deps.selectProjectLensProfile({ ...active, ...body.data }))
    } catch (error) {
      return failure(context, error)
    }
  })
}
