// concern: record-api-trial-space-routes
/** Validates the one authenticated trial-space teardown route. */
import type { Hono } from 'hono'
import { z } from 'zod'
import type { RecordIdentity } from './record-auth.ts'
import type { TrialSpaceDeleteResult } from './record-trial-space-contract.ts'

type Env = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
export function registerRecordTrialSpaceRoutes(
  app: Hono<Env>,
  deps: {
    recordUrl: string
    deleteTrialSpace(input: {
      url: string
      slug: string
      userId: string
    }): Promise<TrialSpaceDeleteResult>
  },
): void {
  app.post('/v1/spaces/delete-trial', async (context) => {
    const body = z
      .object({ slug: z.string().min(1) })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'trial space slug is required' }, 422)
    const identity = context.get('identity')
    return context.json(
      await deps.deleteTrialSpace({
        url: deps.recordUrl,
        slug: body.data.slug,
        userId: identity.user.id,
      }),
    )
  })
}
