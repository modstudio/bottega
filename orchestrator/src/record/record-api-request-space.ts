// concern: record-api-request-space
/** Authorizes an optional request destination against server-owned memberships. */

import type { Context, Hono, Next } from 'hono'
import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import {
  recordSpaceAccessDecision,
  recordSpaceRequestDecision,
} from '../../../shared/record-space-request.ts'
import type { RecordIdentity } from './record-auth.ts'
import { recordSpaceMembershipRefusal } from './record-project-destination.ts'

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
        context.req.method === 'GET' || context.req.method === 'HEAD' ? 'read' : 'write',
        decision.spaceId,
        memberships,
      )
      if (!access.allowed) return context.json({ error: access.error, remedy: access.remedy }, 403)
    }
    if (requested !== null && decision.spaceId !== null)
      context.set('destinationSpaceId', decision.spaceId)
    await next()
  }
  app.use('/v1/projects', requestedSpace)
  app.use('/v1/projects/*', requestedSpace)
  app.use('/v1/docs', requestedSpace)
  app.use('/v1/docs/*', requestedSpace)
  app.use('/v1/subjects', requestedSpace)
  app.use('/v1/subjects/*', requestedSpace)
  app.use('/v1/settings/permission', requestedSpace)
}
