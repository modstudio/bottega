// concern: record-api-outside-block-routes
/** Owns owner-only outside-author block HTTP validation. */

import type { Context, Hono } from 'hono'
import { z } from 'zod'
import {
  isOutsidePauseHours,
  OUTSIDE_PAUSE_MAX_HOURS,
} from '../../../shared/outside-write-decision.ts'
import type { RecordIdentity } from './record-auth.ts'
import type { OutsideBlock } from './record-outside-block.ts'
import { parseRecordRowTarget, type RecordRowTarget } from './record-row-target.ts'

type ApiEnvironment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }

type ParsedBlockBody = { target: RecordRowTarget; hours?: number } | { error: string }

function parseBlockBody(value: unknown): ParsedBlockBody {
  const parsed = parseRecordRowTarget(value)
  if ('error' in parsed) return parsed
  const { body, target } = parsed
  if (
    body.hours !== undefined &&
    (typeof body.hours !== 'number' || !isOutsidePauseHours(body.hours))
  )
    return { error: `hours must be a whole number from 1 to ${OUTSIDE_PAUSE_MAX_HOURS}` }
  return { target, hours: body.hours as number | undefined }
}

export function registerRecordOutsideBlockRoutes(
  app: Hono<ApiEnvironment>,
  deps: {
    blockOutsideAuthor(input: Tenant & RecordRowTarget & { hours?: number }): Promise<OutsideBlock>
    listOutsideBlocks(input: Tenant): Promise<OutsideBlock[]>
    unblockOutsideAuthor(input: Tenant & { blockedUserId: string }): Promise<void>
  },
  route: {
    scope(context: Context<ApiEnvironment>): Tenant | null
    noSpace(context: Context<ApiEnvironment>): Response
    writeError(context: Context<ApiEnvironment>, error: unknown): Response | Promise<Response>
  },
): void {
  app.get('/v1/outside-blocks', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    try {
      return context.json({ blocks: await deps.listOutsideBlocks(active) })
    } catch (error) {
      return route.writeError(context, error)
    }
  })
  app.post('/v1/outside-blocks', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    const parsed = parseBlockBody(await context.req.json().catch(() => null))
    if ('error' in parsed) return context.json({ error: parsed.error }, 400)
    try {
      return context.json({
        block: await deps.blockOutsideAuthor({
          ...active,
          ...parsed.target,
          hours: parsed.hours,
        }),
      })
    } catch (error) {
      return route.writeError(context, error)
    }
  })
  app.delete('/v1/outside-blocks/:userId', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    const userId = z.string().uuid().safeParse(context.req.param('userId'))
    if (!userId.success) return context.json({ error: 'invalid outside block user id' }, 422)
    try {
      await deps.unblockOutsideAuthor({ ...active, blockedUserId: userId.data })
      return context.json({ unblocked: userId.data })
    } catch (error) {
      return route.writeError(context, error)
    }
  })
}
