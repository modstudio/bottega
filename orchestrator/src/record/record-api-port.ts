// concern: record-api-port
/** Exposes validated tenant-bound port item routes. */
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { RecordIdentity } from './record-auth.ts'
import { decodeRecordCursor, pageRecordItems, type RecordCursor } from './record-cursor.ts'
import {
  RecordPortError,
  type RecordPortTable,
  type RecordPortWriteInput,
  recordPortTableSchema,
  recordPortWriteSchema,
} from './record-port-contract.ts'

type Environment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }
export type RecordPortRouteDeps = {
  listPortCatalogue(
    input: Tenant & { table: RecordPortTable; limit: number; cursor: RecordCursor | null },
  ): Promise<Record<string, unknown>[]>
  writePort(input: Tenant & RecordPortWriteInput): Promise<unknown>
}
type Ports = {
  scope(context: Context<Environment>): Tenant | null
  noSpace(context: Context<Environment>): Response
}
const limit = z.coerce.number().int().min(1).max(100).default(20)

export function registerRecordPortRoutes(
  app: Hono<Environment>,
  deps: RecordPortRouteDeps,
  ports: Ports,
): void {
  app.get('/v1/port-catalogue/:table', async (context) => {
    const active = ports.scope(context)
    if (!active) return ports.noSpace(context)
    const table = recordPortTableSchema.safeParse(context.req.param('table'))
    const query = z.object({ limit, cursor: z.string().optional() }).safeParse(context.req.query())
    if (!table.success || !query.success)
      return context.json({ error: 'invalid port catalogue list request' }, 400)
    let cursor = null
    try {
      cursor = query.data.cursor ? decodeRecordCursor(query.data.cursor) : null
    } catch {
      return context.json({ error: 'invalid cursor' }, 400)
    }
    const items = await deps.listPortCatalogue({
      ...active,
      table: table.data,
      limit: query.data.limit,
      cursor,
    })
    const timestamp =
      table.data === 'port_pair'
        ? 'createdAt'
        : table.data === 'port_skip'
          ? 'skippedAt'
          : 'updatedAt'
    return context.json(
      pageRecordItems(
        items,
        query.data.limit,
        (item) => ({ at: String(item[timestamp]), id: String(item.id) }),
        true,
      ),
    )
  })
  app.post('/v1/port-catalogue/write', async (context) => {
    const active = ports.scope(context)
    if (!active) return ports.noSpace(context)
    const body = recordPortWriteSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid port write' }, 400)
    try {
      return context.json(await deps.writePort({ ...active, ...body.data }))
    } catch (error) {
      if (error instanceof RecordPortError)
        return context.json({ error: error.message }, error.status as 404 | 409 | 422)
      throw error
    }
  })
}
