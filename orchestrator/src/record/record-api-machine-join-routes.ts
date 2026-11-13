// concern: record API machine join routes
/** Validates and renders tenant-bound relay mailbox operations. */

import type { Context, Hono } from 'hono'
import { z } from 'zod'
import {
  MACHINE_JOIN_MESSAGE_MAX_BYTES,
  MACHINE_JOIN_PHASE_PATTERN,
  MACHINE_JOIN_SIDE_PATTERN,
} from '../../../shared/machine-join-wire.ts'
import { NAMEPLATE_PATTERN } from '../../../shared/pairing-code.ts'
import type { RecordConfigRouteDeps } from './record-api-config-contract.ts'
import { base64urlSchema, decoded, encoded } from './record-api-wire.ts'
import type { RecordIdentity } from './record-auth.ts'

type ApiEnvironment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }
type Routes = Pick<
  RecordConfigRouteDeps,
  | 'allocateMachineJoinNameplate'
  | 'postMachineJoinMessage'
  | 'readMachineJoinMessages'
  | 'failMachineJoinNameplate'
>
type RouteContext = {
  scope(context: Context<ApiEnvironment>): Tenant | null
  noSpace(context: Context<ApiEnvironment>): Response
  writeError(context: Context<ApiEnvironment>, error: unknown): Response
}

const nameplateSchema = z.string().regex(NAMEPLATE_PATTERN)
const sideSchema = z.string().regex(MACHINE_JOIN_SIDE_PATTERN)
const phaseSchema = z.string().regex(MACHINE_JOIN_PHASE_PATTERN)

export function registerRecordMachineJoinRoutes(
  app: Hono<ApiEnvironment>,
  deps: Routes,
  route: RouteContext,
): void {
  app.post('/v1/config/join/nameplates', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    const text = await context.req.text()
    let value: unknown = {}
    try {
      if (text !== '') value = JSON.parse(text)
    } catch {
      return context.json({ error: 'machine join allocation body must be empty' }, 400)
    }
    if (!z.object({}).strict().safeParse(value).success)
      return context.json({ error: 'machine join allocation body must be empty' }, 400)
    try {
      return context.json(await deps.allocateMachineJoinNameplate(active))
    } catch (error) {
      return route.writeError(context, error)
    }
  })

  app.post('/v1/config/join/nameplates/:nameplate/messages', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    const nameplate = nameplateSchema.safeParse(context.req.param('nameplate'))
    const body = z
      .object({ side: sideSchema, phase: phaseSchema, body: base64urlSchema })
      .strict()
      .safeParse(await context.req.json().catch(() => null))
    if (!nameplate.success || !body.success)
      return context.json({ error: 'invalid machine join message' }, 400)
    const message = decoded(body.data.body)
    if (message.byteLength > MACHINE_JOIN_MESSAGE_MAX_BYTES)
      return context.json(
        { error: `machine join message body exceeds ${MACHINE_JOIN_MESSAGE_MAX_BYTES} bytes` },
        400,
      )
    try {
      await deps.postMachineJoinMessage({
        ...active,
        nameplate: nameplate.data,
        side: body.data.side,
        phase: body.data.phase,
        body: message,
      })
      return context.json({ stored: true })
    } catch (error) {
      return route.writeError(context, error)
    }
  })

  app.get('/v1/config/join/nameplates/:nameplate/messages', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    const nameplate = nameplateSchema.safeParse(context.req.param('nameplate'))
    const side = sideSchema.safeParse(context.req.query('side'))
    if (!nameplate.success || !side.success)
      return context.json({ error: 'invalid machine join message query' }, 400)
    try {
      const mailbox = await deps.readMachineJoinMessages({
        ...active,
        nameplate: nameplate.data,
        side: side.data,
      })
      return context.json({
        expiresAt: mailbox.expiresAt,
        messages: mailbox.messages.map((message) => ({ ...message, body: encoded(message.body) })),
      })
    } catch (error) {
      return route.writeError(context, error)
    }
  })

  app.post('/v1/config/join/nameplates/:nameplate/failure', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    const nameplate = nameplateSchema.safeParse(context.req.param('nameplate'))
    const body = z
      .object({ side: sideSchema })
      .strict()
      .safeParse(await context.req.json().catch(() => null))
    if (!nameplate.success || !body.success)
      return context.json({ error: 'invalid machine join failure report' }, 400)
    try {
      await deps.failMachineJoinNameplate({
        ...active,
        nameplate: nameplate.data,
        side: body.data.side,
      })
      return context.json({ failed: true })
    } catch (error) {
      return route.writeError(context, error)
    }
  })
}
