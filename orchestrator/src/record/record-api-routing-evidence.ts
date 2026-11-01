// concern: record-api-routing-evidence
/** Validates and pages the hosted routing-evidence HTTP surface. */

import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { RecordIdentity } from './record-auth.ts'
import type { RecordCursor } from './record-cursor.ts'
import { decodeRecordCursor, pageRecordItems, recordCursorOf } from './record-cursor.ts'
import type { RecordRoutingEvidenceRow } from './record-routing-evidence.ts'

const ROUTING_EVIDENCE_LIMIT_MAX = 100

type ApiEnvironment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string }
export type RoutingEvidenceRouteDeps = {
  recordUrl: string
  listRoutingEvidence(
    input: Tenant & {
      updatedSince?: string
      limit: number
      cursor: RecordCursor | null
    },
  ): Promise<RecordRoutingEvidenceRow[]>
}

const querySchema = z.object({
  spaceId: z.string().uuid(),
  updatedSince: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(ROUTING_EVIDENCE_LIMIT_MAX).default(20),
  cursor: z.string().optional(),
})

export function registerRecordRoutingEvidenceRoute(
  app: Hono<ApiEnvironment>,
  deps: RoutingEvidenceRouteDeps,
): void {
  app.get('/v1/routing-evidence', async (context: Context<ApiEnvironment>) => {
    const query = querySchema.safeParse(context.req.query())
    if (!query.success) return context.json({ error: 'invalid routing evidence query' }, 400)
    let cursor = null
    try {
      cursor = query.data.cursor ? decodeRecordCursor(query.data.cursor) : null
    } catch {
      return context.json({ error: 'invalid cursor' }, 400)
    }
    const identity = context.get('identity')
    const items = await deps.listRoutingEvidence({
      url: deps.recordUrl,
      userId: identity.user.id,
      spaceId: query.data.spaceId,
      updatedSince: query.data.updatedSince,
      limit: query.data.limit,
      cursor,
    })
    return context.json(pageRecordItems(items, query.data.limit, recordCursorOf, true))
  })
}
