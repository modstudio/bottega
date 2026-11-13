// concern: record-api-machine-key-claim-routes
/** Owns the machine-key HTTP routes: list, register, revoke and claim. */

import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { KEY_SIZE } from '../../../shared/secret-envelope.ts'
import type { RecordConfigRouteDeps } from './record-api-config-contract.ts'
import { base64urlSchema, decoded, encoded, idSchema, keyIdSchema } from './record-api-wire.ts'
import type { RecordIdentity } from './record-auth.ts'
import type { MachineKeyClaimChallenge } from './record-config.ts'

type ApiEnvironment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }
type Routes = Pick<
  RecordConfigRouteDeps,
  'listMachineKeys' | 'registerMachineKey' | 'revokeMachineKey'
> & {
  createMachineKeyClaimChallenge(
    input: Tenant & { keyId: string },
  ): Promise<MachineKeyClaimChallenge>
  claimMachineKey(
    input: Tenant & { keyId: string; challengeId: string; nonce: Uint8Array },
  ): Promise<void>
}
type RouteContext = {
  scope(context: Context<ApiEnvironment>): Tenant | null
  noSpace(context: Context<ApiEnvironment>): Response
  writeError(context: Context<ApiEnvironment>, error: unknown): Response
}

export function registerRecordMachineKeyClaimRoutes(
  app: Hono<ApiEnvironment>,
  deps: Routes,
  route: RouteContext,
): void {
  app.get('/v1/config/machine-keys', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    const items = await deps.listMachineKeys(active)
    return context.json({
      items: items.map((item) => ({
        ...item,
        publicKey: encoded(item.publicKey),
        signingPublicKey: item.signingPublicKey === null ? null : encoded(item.signingPublicKey),
      })),
    })
  })
  app.put('/v1/config/machine-keys/:keyId', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    const keyId = keyIdSchema.safeParse(context.req.param('keyId'))
    const body = z
      .object({
        publicKey: base64urlSchema,
        signingPublicKey: base64urlSchema.optional(),
        label: z.string().trim().min(1),
      })
      .safeParse(await context.req.json().catch(() => null))
    if (!keyId.success || !body.success)
      return context.json({ error: 'invalid machine key body' }, 422)
    const publicKey = decoded(body.data.publicKey)
    if (publicKey.byteLength !== KEY_SIZE)
      return context.json({ error: 'machine public key must be 32 bytes' }, 422)
    const signingPublicKey = body.data.signingPublicKey
      ? decoded(body.data.signingPublicKey)
      : undefined
    if (signingPublicKey && signingPublicKey.byteLength !== KEY_SIZE)
      return context.json({ error: 'machine signing public key must be 32 bytes' }, 422)
    try {
      const item = await deps.registerMachineKey({
        ...active,
        keyId: keyId.data,
        publicKey,
        signingPublicKey,
        label: body.data.label,
      })
      return context.json({
        ...item,
        publicKey: encoded(item.publicKey),
        signingPublicKey: item.signingPublicKey === null ? null : encoded(item.signingPublicKey),
      })
    } catch (error) {
      return route.writeError(context, error)
    }
  })
  app.post('/v1/config/machine-keys/:keyId/revoke', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    const keyId = keyIdSchema.safeParse(context.req.param('keyId'))
    if (!keyId.success) return context.json({ error: 'invalid machine key id' }, 422)
    try {
      await deps.revokeMachineKey({ ...active, keyId: keyId.data })
      return context.json({ revoked: true })
    } catch (error) {
      return route.writeError(context, error)
    }
  })
  app.post('/v1/config/machine-keys/:keyId/claim-challenge', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    const keyId = keyIdSchema.safeParse(context.req.param('keyId'))
    if (!keyId.success) return context.json({ error: 'invalid machine key id' }, 422)
    try {
      const item = await deps.createMachineKeyClaimChallenge({ ...active, keyId: keyId.data })
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
    if (!keyId.success || !body.success || decoded(body.data.nonce).byteLength !== KEY_SIZE)
      return context.json({ error: 'invalid machine key claim body' }, 422)
    try {
      await deps.claimMachineKey({
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
}
