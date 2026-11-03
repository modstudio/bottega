// concern: record-api-machine-key-claim-routes
/** Owns machine-key claim HTTP validation. */

import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { KEY_SIZE } from '../../../shared/secret-envelope.ts'
import { base64urlSchema, decoded, encoded, idSchema, keyIdSchema } from './record-api-wire.ts'
import type { RecordIdentity } from './record-auth.ts'
import type { MachineKeyClaimChallenge } from './record-config.ts'

type ApiEnvironment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }
type Routes = {
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
