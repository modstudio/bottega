// concern: record-api-routing-evidence
/** Validates and pages the hosted routing-evidence HTTP surface. */

import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { RecordIdentity } from './record-auth.ts'
import type { RecordRoutingEvidenceRow } from './record-routing-evidence.ts'

const ROUTING_EVIDENCE_LIMIT_MAX = 100

type ApiEnvironment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string }
export type RoutingEvidenceRouteDeps = {
  recordUrl: string
  listRoutingEvidence(
    input: Tenant & {
      limit: number
      cursor: bigint | null
    },
  ): Promise<RecordRoutingEvidenceRow[]>
}

const querySchema = z.object({
  spaceId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(ROUTING_EVIDENCE_LIMIT_MAX).default(20),
  cursor: z.string().optional(),
})

const encodeRoutingEvidenceCursor = (sequence: bigint): string => btoa(sequence.toString())

export function decodeRoutingEvidenceCursor(value: string): bigint {
  const decoded = atob(value)
  if (!/^[1-9][0-9]*$/.test(decoded)) throw new Error('invalid cursor parameter')
  return BigInt(decoded)
}

export function registerRecordRoutingEvidenceRoute(
  app: Hono<ApiEnvironment>,
  deps: RoutingEvidenceRouteDeps,
): void {
  app.get('/v1/routing-evidence', async (context: Context<ApiEnvironment>) => {
    const query = querySchema.safeParse(context.req.query())
    if (!query.success) return context.json({ error: 'invalid routing evidence query' }, 400)
    let cursor = null
    try {
      cursor = query.data.cursor ? decodeRoutingEvidenceCursor(query.data.cursor) : null
    } catch {
      return context.json({ error: 'invalid cursor parameter' }, 400)
    }
    const identity = context.get('identity')
    const items = await deps.listRoutingEvidence({
      url: deps.recordUrl,
      userId: identity.user.id,
      spaceId: query.data.spaceId,
      limit: query.data.limit,
      cursor,
    })
    const hasMore = items.length > query.data.limit
    if (hasMore) items.pop()
    const last = items.at(-1)
    const endCursor = last ? encodeRoutingEvidenceCursor(last.evidenceSequence) : null
    return context.json({
      items: items.map(({ evidenceSequence: _sequence, ...item }) => item),
      nextCursor: hasMore ? endCursor : null,
      endCursor,
    })
  })
}
