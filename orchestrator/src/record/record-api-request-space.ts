// concern: record-api-request-space
/** Authorizes an optional request destination against server-owned memberships. */

import type { Context, Hono, Next } from 'hono'
import { recordSpaceMembershipRefusal } from '../../../shared/record-remedies.ts'
import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import {
  recordRequestNature,
  recordSpaceAccessDecision,
  recordSpaceRequestDecision,
} from '../../../shared/record-space-request.ts'
import type { RecordIdentity } from './record-auth.ts'

type ApiEnvironment = {
  Variables: { identity: RecordIdentity; destinationSpaceId?: string }
}

/** Install destination authorization on project-owned record operations. */
export function registerRecordRequestSpace(app: Hono<ApiEnvironment>): void {
  const requestedSpace = async (context: Context<ApiEnvironment>, next: Next) => {
    if (context.req.method === 'GET' && context.req.path === '/v1/docs/search') return next()
    const requested = context.req.header('x-record-space') ?? null
    const memberships = parseRecordSpaceMemberships(context.get('identity').memberships)
    const decision = recordSpaceRequestDecision(
      requested,
      context.get('identity').activeSpaceId,
      memberships,
    )
    if (!decision.allowed) {
      return context.json(
        {
          error: `signed-in user is not a member of record space ${decision.requestedSpace}`,
          remedy: recordSpaceMembershipRefusal(decision.requestedSpace),
        },
        403,
      )
    }
    if (decision.spaceId !== null) {
      const access = recordSpaceAccessDecision(
        recordRequestNature(context.req.method),
        decision.spaceId,
        memberships,
      )
      if (!access.allowed) return context.json({ error: access.error, remedy: access.remedy }, 403)
    }
    if (requested !== null && decision.spaceId !== null)
      context.set('destinationSpaceId', decision.spaceId)
    await next()
  }
  const prefixes = [
    '/v1/projects',
    '/v1/releases',
    '/v1/docs',
    '/v1/subjects',
    '/v1/lens-catalogue',
    '/v1/workflow-catalogue',
    '/v1/task-flow',
    '/v1/port-catalogue',
    '/v1/settings/permission',
    '/v1/settings/auto-mode',
    '/v1/config',
    '/v1/runs',
    '/v1/board/messages',
    '/v1/board/changes',
    '/v1/board/successor',
    '/v1/board/receipts',
    '/v1/board/claims',
    '/v1/snapshots',
  ] as const
  for (const prefix of prefixes) {
    app.use(prefix, requestedSpace)
    app.use(`${prefix}/*`, requestedSpace)
  }
}
