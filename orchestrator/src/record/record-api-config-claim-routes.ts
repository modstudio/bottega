// concern: record-api-config-claim-routes
/** Owns machine-key claim and member config-access HTTP validation. */
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { RecordIdentity } from './record-auth.ts'
import type { MachineKeyClaimChallenge, SpaceConfigAccessMember } from './record-config.ts'
import { MACHINE_KEY_ID_PATTERN } from './record-config.ts'

type ApiEnvironment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }
type Routes = {
  createMachineKeyClaimChallenge?(
    input: Tenant & { keyId: string },
  ): Promise<MachineKeyClaimChallenge>
  claimMachineKey?(
    input: Tenant & { keyId: string; challengeId: string; nonce: Uint8Array },
  ): Promise<void>
  listSpaceConfigAccess?(input: Tenant): Promise<SpaceConfigAccessMember[]>
  grantSpaceConfigAccess?(input: Tenant & { email: string }): Promise<void>
}
type RouteContext = {
  scope(context: Context<ApiEnvironment>): Tenant | null
  noSpace(context: Context<ApiEnvironment>): Response
  writeError(context: Context<ApiEnvironment>, error: unknown): Response
}

const keyIdSchema = z.string().regex(MACHINE_KEY_ID_PATTERN)
const idSchema = z.string().uuid()
const base64urlSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => Buffer.from(value, 'base64url').toString('base64url') === value)
const encoded = (value: Uint8Array) => Buffer.from(value).toString('base64url')
const decoded = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'))

export function registerRecordConfigClaimRoutes(
  app: Hono<ApiEnvironment>,
  deps: Routes,
  route: RouteContext,
): void {
  app.post('/v1/config/machine-keys/:keyId/claim-challenge', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    const keyId = keyIdSchema.safeParse(context.req.param('keyId'))
    if (!keyId.success) return context.json({ error: 'invalid machine key id' }, 422)
    try {
      const item = await deps.createMachineKeyClaimChallenge!({ ...active, keyId: keyId.data })
      return context.json({
        challengeId: item.challengeId,
        enc: encoded(item.enc),
        ciphertext: encoded(item.ciphertext),
        senderPublicKey: encoded(item.senderPublicKey),
      })
    } catch (error) {
      return route.writeError(context, error)
    }
  })
  app.post('/v1/config/machine-keys/:keyId/claim', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    const keyId = keyIdSchema.safeParse(context.req.param('keyId'))
    const body = z
      .object({ challengeId: idSchema, nonce: base64urlSchema })
      .safeParse(await context.req.json().catch(() => null))
    if (!keyId.success || !body.success || decoded(body.data.nonce).byteLength !== 32)
      return context.json({ error: 'invalid machine key claim body' }, 422)
    try {
      await deps.claimMachineKey!({
        ...active,
        keyId: keyId.data,
        challengeId: body.data.challengeId,
        nonce: decoded(body.data.nonce),
      })
      return context.json({ claimed: true })
    } catch (error) {
      return route.writeError(context, error)
    }
  })
  app.get('/v1/config-access', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    return context.json({ items: await deps.listSpaceConfigAccess!(active) })
  })
  app.post('/v1/config-access/grant', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    const body = z
      .object({ email: z.string().email() })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid config access grant body' }, 422)
    try {
      await deps.grantSpaceConfigAccess!({ ...active, email: body.data.email })
      return context.json({ granted: true })
    } catch (error) {
      return route.writeError(context, error)
    }
  })
}
