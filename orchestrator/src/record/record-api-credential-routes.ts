// concern: record-api-credential-routes
/** Owns hosted payer-preference routes. */

import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { RecordIdentity } from './record-auth.ts'
import type { ConfigTenant } from './record-config.ts'
import type { CredentialPreference } from './record-credential.ts'

type Environment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = Omit<ConfigTenant, 'spaceIds'> & { spaceIds: string[] }
export type RecordCredentialRouteDeps = {
  listCredentialPreferences(input: Tenant): Promise<CredentialPreference[]>
  putCredentialPreference(
    input: Tenant & Omit<CredentialPreference, 'updatedAt'>,
  ): Promise<CredentialPreference>
  deleteCredentialPreference(
    input: Tenant & Pick<CredentialPreference, 'projectId' | 'provider' | 'type' | 'environment'>,
  ): Promise<void>
}
const address = z.object({
  projectId: z.string().uuid().nullable(),
  provider: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  type: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  environment: z.enum(['live', 'test', 'default']),
})

export function registerRecordCredentialRoutes(
  app: Hono<Environment>,
  deps: RecordCredentialRouteDeps,
  helpers: {
    scope(context: Context<Environment>): Tenant | null
    noSpace(context: Context<Environment>): Response
  },
): void {
  app.get('/v1/config/credential-preferences', async (context) => {
    const tenant = helpers.scope(context)
    return tenant
      ? context.json({ items: await deps.listCredentialPreferences(tenant) })
      : helpers.noSpace(context)
  })
  app.put('/v1/config/credential-preferences', async (context) => {
    const tenant = helpers.scope(context)
    if (!tenant) return helpers.noSpace(context)
    const body = address
      .extend({ payer: z.enum(['personal', 'shared']), binding: z.enum(['project', 'space']) })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid credential preference body' }, 422)
    return context.json(await deps.putCredentialPreference({ ...tenant, ...body.data }))
  })
  app.delete('/v1/config/credential-preferences', async (context) => {
    const tenant = helpers.scope(context)
    if (!tenant) return helpers.noSpace(context)
    const body = address.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid credential preference body' }, 422)
    await deps.deleteCredentialPreference({ ...tenant, ...body.data })
    return context.json({ deleted: true })
  })
}
