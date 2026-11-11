// concern: record-api-trial-space-routes
/** Validates the authenticated trial and general space-delete routes. */
import type { Hono } from 'hono'
import { z } from 'zod'
import type { RecordIdentity } from './record-auth.ts'
import type { SpaceDeleteResult } from './record-trial-space-contract.ts'

type Env = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
export function registerRecordTrialSpaceRoutes(
  app: Hono<Env>,
  deps: {
    recordUrl: string
    deleteTrialSpace?(input: {
      url: string
      slug: string
      userId: string
      activeSpaceId: string | null
    }): Promise<SpaceDeleteResult>
    deleteSpace?(input: {
      url: string
      slug: string
      confirmation: string
      userId: string
      activeSpaceId: string | null
    }): Promise<SpaceDeleteResult>
  },
): void {
  const deleteTrialSpace = deps.deleteTrialSpace
  if (deleteTrialSpace)
    app.post('/v1/spaces/delete-trial', async (context) => {
      const body = z
        .object({ slug: z.string().min(1) })
        .safeParse(await context.req.json().catch(() => null))
      if (!body.success) return context.json({ error: 'trial space slug is required' }, 422)
      const identity = context.get('identity')
      return context.json(
        await deleteTrialSpace({
          url: deps.recordUrl,
          slug: body.data.slug,
          userId: identity.user.id,
          activeSpaceId: identity.activeSpaceId,
        }),
      )
    })
  const deleteSpace = deps.deleteSpace
  if (deleteSpace)
    app.post('/v1/spaces/delete', async (context) => {
      const body = z
        .object({ slug: z.string().min(1), confirmation: z.string().min(1) })
        .safeParse(await context.req.json().catch(() => null))
      if (!body.success)
        return context.json({ error: 'space slug and confirmation are required' }, 422)
      const identity = context.get('identity')
      return context.json(
        await deleteSpace({
          url: deps.recordUrl,
          slug: body.data.slug,
          confirmation: body.data.confirmation,
          userId: identity.user.id,
          activeSpaceId: identity.activeSpaceId,
        }),
      )
    })
}
