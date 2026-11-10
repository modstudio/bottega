// concern: record-api-moderation-routes
/** Owns owner-only moderation hide HTTP validation. */

import type { Context, Hono } from 'hono'
import {
  isModerationHideReason,
  MODERATION_HIDE_REASONS,
  type ModerationHideReason,
} from '../../../shared/moderation-hide-reason.ts'
import type { RecordIdentity } from './record-auth.ts'
import type { HiddenRow } from './record-moderation-hide.ts'
import { parseRecordRowTarget, type RecordRowTarget } from './record-row-target.ts'

type ApiEnvironment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }

export function registerRecordModerationRoutes(
  app: Hono<ApiEnvironment>,
  deps: {
    hideRow(input: Tenant & RecordRowTarget & { reason: ModerationHideReason }): Promise<HiddenRow>
    unhideRow(input: Tenant & RecordRowTarget): Promise<void>
    listHidden(input: Tenant): Promise<HiddenRow[]>
  },
  route: {
    scope(context: Context<ApiEnvironment>): Tenant | null
    noSpace(context: Context<ApiEnvironment>): Response
    writeError(context: Context<ApiEnvironment>, error: unknown): Response | Promise<Response>
  },
): void {
  app.post('/v1/moderation/hide', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    const parsed = parseRecordRowTarget(await context.req.json().catch(() => null))
    if ('error' in parsed) return context.json({ error: parsed.error }, 400)
    const { body, target } = parsed
    if (!isModerationHideReason(body.reason))
      return context.json(
        { error: `reason must be one of: ${MODERATION_HIDE_REASONS.join(', ')}` },
        400,
      )
    try {
      return context.json({
        hidden: await deps.hideRow({ ...active, ...target, reason: body.reason }),
      })
    } catch (error) {
      return route.writeError(context, error)
    }
  })
  app.post('/v1/moderation/unhide', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    const parsed = parseRecordRowTarget(await context.req.json().catch(() => null))
    if ('error' in parsed) return context.json({ error: parsed.error }, 400)
    try {
      await deps.unhideRow({ ...active, ...parsed.target })
      return context.json({ unhidden: true })
    } catch (error) {
      return route.writeError(context, error)
    }
  })
  app.get('/v1/moderation/hidden', async (context) => {
    const active = route.scope(context)
    if (!active) return route.noSpace(context)
    try {
      return context.json({ hidden: await deps.listHidden(active) })
    } catch (error) {
      return route.writeError(context, error)
    }
  })
}
