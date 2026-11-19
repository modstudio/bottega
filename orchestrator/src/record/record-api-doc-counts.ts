// concern: record-api-doc-counts
/** Serves the active-space document and score counts. */

import type { Context, Hono } from 'hono'
import type { RecordDocumentTenant } from './record-api-doc-tenant.ts'
import type { RecordIdentity } from './record-auth.ts'
import type { RecordCacheCounts } from './record-cache-counts.ts'

type ApiEnvironment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }

export function registerRecordDocCountsRoute(
  app: Hono<ApiEnvironment>,
  deps: {
    countDocs(input: RecordDocumentTenant): Promise<{ docs: number; revisions: number }>
    countScores(input: RecordDocumentTenant): Promise<{ scores: number; voids: number }>
    countCacheRows(input: RecordDocumentTenant): Promise<RecordCacheCounts>
  },
  ports: {
    scope(context: Context<ApiEnvironment>): RecordDocumentTenant | null
    noSpace(context: Context<ApiEnvironment>): Response
  },
): void {
  app.get('/v1/docs/counts', async (context) => {
    const tenant = ports.scope(context)
    if (!tenant) return ports.noSpace(context)
    const docs = await deps.countDocs(tenant)
    const scores = await deps.countScores(tenant)
    if (context.req.query('by') !== 'scope') return context.json({ ...docs, ...scores })
    const cache = await deps.countCacheRows(tenant)
    return context.json({ ...docs, ...scores, ...cache })
  })
}
