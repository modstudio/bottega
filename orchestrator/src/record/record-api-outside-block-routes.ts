// concern: record-api-outside-block-routes
/** Owns owner-only outside-author block HTTP validation. */

import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { type NoteLabel, parseNoteLabel } from '../../../shared/note-label.ts'
import {
  isOutsidePauseHours,
  OUTSIDE_PAUSE_MAX_HOURS,
} from '../../../shared/outside-write-decision.ts'
import type { RecordIdentity } from './record-auth.ts'
import type { OutsideBlock, OutsideBlockTarget } from './record-outside-block.ts'

type ApiEnvironment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }

function noteLabelRefusal(value: unknown): string {
  return `invalid note label '${String(value)}': expected project#number`
}

type ParsedBlockBody = { target: OutsideBlockTarget; hours?: number } | { error: string }

function parseBlockNote(value: unknown): { note: NoteLabel } | { error: string } {
  if (typeof value !== 'string') return { error: noteLabelRefusal(value) }
  try {
    return { note: parseNoteLabel(value) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : noteLabelRefusal(value) }
  }
}

function parseBlockBody(value: unknown): ParsedBlockBody {
  const body =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const hasMessage = body.message !== undefined
  const hasNote = body.note !== undefined
  if (hasMessage === hasNote) return { error: 'exactly one of message or note is required' }
  let target: OutsideBlockTarget
  if (hasMessage) {
    if (!z.string().uuid().safeParse(body.message).success)
      return { error: 'message must be a board message id' }
    target = { message: String(body.message) }
  } else {
    const parsed = parseBlockNote(body.note)
    if ('error' in parsed) return parsed
    target = parsed
  }
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
    blockOutsideAuthor(
      input: Tenant & OutsideBlockTarget & { hours?: number },
    ): Promise<OutsideBlock>
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
