// concern: record-api-credential-routes
/** Owns hosted payer-preference routes. */

import type { Context, Hono } from 'hono'
import { z } from 'zod'
import {
  CREDENTIAL_BINDINGS,
  CREDENTIAL_ENVIRONMENTS,
  CREDENTIAL_MODES,
  CREDENTIAL_PAYERS,
  CREDENTIAL_SLUG_PATTERN,
  type CredentialPreferencePayload,
} from '../../../shared/credential.ts'
import type { RecordIdentity } from './record-auth.ts'
import type { ConfigTenant } from './record-config.ts'
import type { CredentialPreference } from './record-credential.ts'

type Environment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = Omit<ConfigTenant, 'spaceIds'> & { spaceIds: string[] }
export type RecordCredentialRouteDeps = {
  listCredentialPreferences(input: Tenant): Promise<CredentialPreference[]>
  putCredentialPreference(
    input: Tenant & CredentialPreferencePayload,
  ): Promise<CredentialPreference>
  deleteCredentialPreference(
    input: Tenant &
      Pick<
        CredentialPreference,
        'projectId' | 'provider' | 'name' | 'type' | 'mode' | 'environment'
      >,
  ): Promise<void>
}
const address = z.object({
  projectId: z.string().uuid().nullable(),
  provider: z.string().regex(CREDENTIAL_SLUG_PATTERN),
  name: z.string().regex(CREDENTIAL_SLUG_PATTERN).nullable(),
  type: z.string().regex(CREDENTIAL_SLUG_PATTERN),
  mode: z.enum(CREDENTIAL_MODES),
  environment: z.enum(CREDENTIAL_ENVIRONMENTS),
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
      .extend({ payer: z.enum(CREDENTIAL_PAYERS), binding: z.enum(CREDENTIAL_BINDINGS) })
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
