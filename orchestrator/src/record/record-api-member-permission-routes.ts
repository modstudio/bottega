// concern: record-api-member-permission-routes
/** Owns member permission HTTP validation. */

import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { RecordIdentity } from './record-auth.ts'
import { MEMBER_PERMISSIONS, type MemberPermission } from './record-member-permission.ts'

type ApiEnvironment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }
type Routes = {
  setSpaceMemberPermission(
    input: Tenant & { email: string; permission: MemberPermission },
  ): Promise<{ permission: MemberPermission }>
}
type RouteContext = {
  scope(context: Context<ApiEnvironment>): Tenant | null
  noSpace(context: Context<ApiEnvironment>): Response
  writeError(context: Context<ApiEnvironment>, error: unknown): Response
}

export function registerRecordMemberPermissionRoutes(
  app: Hono<ApiEnvironment>,
  deps: Routes,
  route: RouteContext,
): void {
  app.post('/v1/members/permission', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    const body = z
      .object({ email: z.string().email(), permission: z.enum(MEMBER_PERMISSIONS) })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid member permission body' }, 422)
    try {
      return context.json(await deps.setSpaceMemberPermission({ ...active, ...body.data }))
    } catch (error) {
      return route.writeError(context, error)
    }
  })
}
