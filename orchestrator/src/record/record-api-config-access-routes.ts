// concern: record-api-config-access-routes
/** Owns member config-access HTTP validation. */

import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { RecordIdentity } from './record-auth.ts'
import type { SpaceConfigAccessMember, WithdrawSpaceConfigAccessResult } from './record-config.ts'

type ApiEnvironment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }
type Routes = {
  listSpaceConfigAccess(input: Tenant): Promise<SpaceConfigAccessMember[]>
  grantSpaceConfigAccess(input: Tenant & { email: string }): Promise<void>
  withdrawSpaceConfigAccess(
    input: Tenant & { email: string },
  ): Promise<WithdrawSpaceConfigAccessResult>
}
type RouteContext = {
  scope(context: Context<ApiEnvironment>): Tenant | null
  noSpace(context: Context<ApiEnvironment>): Response
  writeError(context: Context<ApiEnvironment>, error: unknown): Response
}

export function registerRecordConfigAccessRoutes(
  app: Hono<ApiEnvironment>,
  deps: Routes,
  route: RouteContext,
): void {
  app.get('/v1/config-access', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    return context.json({ items: await deps.listSpaceConfigAccess(active) })
  })
  app.post('/v1/config-access/grant', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    const body = z
      .object({ email: z.string().email() })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid config access grant body' }, 422)
    try {
      await deps.grantSpaceConfigAccess({ ...active, email: body.data.email })
      return context.json({ granted: true })
    } catch (error) {
      return route.writeError(context, error)
    }
  })
  app.post('/v1/config-access/withdraw', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    const body = z
      .object({ email: z.string().email() })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid config access withdrawal body' }, 422)
    try {
      return context.json(
        await deps.withdrawSpaceConfigAccess({ ...active, email: body.data.email }),
      )
    } catch (error) {
      return route.writeError(context, error)
    }
  })
}
