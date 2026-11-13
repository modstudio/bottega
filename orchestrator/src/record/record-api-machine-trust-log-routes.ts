// concern: record API machine trust log routes
/** Validates and renders tenant-bound trust-log reads and appends. */

import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { RecordConfigRouteDeps } from './record-api-config-contract.ts'
import { base64urlSchema, decoded, encoded } from './record-api-wire.ts'
import type { RecordIdentity } from './record-auth.ts'

type ApiEnvironment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }
type Routes = Pick<RecordConfigRouteDeps, 'readMachineTrustLog' | 'appendMachineTrustLogEntry'>
type RouteContext = {
  scope(context: Context<ApiEnvironment>): Tenant | null
  noSpace(context: Context<ApiEnvironment>): Response
  writeError(context: Context<ApiEnvironment>, error: unknown): Response
}

export function registerRecordMachineTrustLogRoutes(
  app: Hono<ApiEnvironment>,
  deps: Routes,
  route: RouteContext,
): void {
  app.get('/v1/config/trust-log', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    return context.json({ entries: (await deps.readMachineTrustLog(active)).map(encoded) })
  })
  app.post('/v1/config/trust-log', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    const body = z
      .object({ expectedHead: base64urlSchema.nullable(), entry: base64urlSchema })
      .strict()
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid machine trust log append body' }, 400)
    const expectedHead = body.data.expectedHead === null ? null : decoded(body.data.expectedHead)
    if (expectedHead !== null && expectedHead.byteLength !== 32)
      return context.json({ error: 'machine trust log expectedHead must be 32 bytes' }, 400)
    try {
      const hash = await deps.appendMachineTrustLogEntry({
        ...active,
        expectedHead,
        entry: decoded(body.data.entry),
      })
      return context.json({ hash: encoded(hash) })
    } catch (error) {
      return route.writeError(context, error)
    }
  })
}
