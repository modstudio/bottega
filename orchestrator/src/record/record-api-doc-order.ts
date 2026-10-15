// concern: record-api-doc-order
/** Validates and serves the hosted document-order write edge. */

import type { Context, Hono } from 'hono'
import { recordDocOrderSchema } from './record-api-doc-schemas.ts'
import type { RecordIdentity } from './record-auth.ts'
import type { RecordDocOrderInput } from './record-docs.ts'

type ApiEnvironment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }

type Deps = {
  reorderDocs(input: Tenant & RecordDocOrderInput): Promise<{ orderedIds: string[] }>
}

type Ports = {
  scope(context: Context<ApiEnvironment>): Tenant | null
  noSpace(context: Context<ApiEnvironment>): Response
  writeError(context: Context<ApiEnvironment>, error: unknown): Response
}

export function registerRecordDocOrderRoute(
  app: Hono<ApiEnvironment>,
  deps: Deps,
  ports: Ports,
): void {
  app.put('/v1/docs/order', async (context) => {
    const tenant = ports.scope(context)
    if (!tenant) return ports.noSpace(context)
    const body = recordDocOrderSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid doc order' }, 400)
    try {
      return context.json(await deps.reorderDocs({ ...tenant, ...body.data }))
    } catch (error) {
      return ports.writeError(context, error)
    }
  })
}
