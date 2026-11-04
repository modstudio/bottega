// concern: record-api-outside-intake-routes
/** Owns owner-only outside-intake HTTP validation. */

import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { RecordIdentity } from './record-auth.ts'
import type { OutsideIntake } from './record-outside-intake.ts'

type ApiEnvironment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }

export function registerRecordOutsideIntakeRoutes(
  app: Hono<ApiEnvironment>,
  deps: {
    showOutsideIntake(input: Tenant): Promise<OutsideIntake | null>
    setOutsideIntake(input: Tenant & { project: string }): Promise<OutsideIntake>
  },
  route: {
    scope(context: Context<ApiEnvironment>): Tenant | null
    noSpace(context: Context<ApiEnvironment>): Response
    writeError(context: Context<ApiEnvironment>, error: unknown): Response | Promise<Response>
  },
): void {
  app.get('/v1/outside-intake', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    return context.json({ intake: await deps.showOutsideIntake(active) })
  })
  app.post('/v1/outside-intake', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    const body = z
      .object({ project: z.string().min(1) })
      .strict()
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid outside intake body' }, 422)
    try {
      return context.json({ intake: await deps.setOutsideIntake({ ...active, ...body.data }) })
    } catch (error) {
      return route.writeError(context, error)
    }
  })
}
