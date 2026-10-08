// concern: record-api-request-space
/** Authorizes an optional request destination against server-owned memberships. */

import type { Context, Hono, Next } from 'hono'
import {
  parseRecordSpaceMemberships,
  type RecordSpaceMembership,
  recordSpaceMembership,
} from '../../../shared/record-space-membership.ts'
import type { RecordIdentity } from './record-auth.ts'

type ApiEnvironment = {
  Variables: { identity: RecordIdentity; destinationSpaceId?: string }
}

export type RecordRequestSpaceDecision =
  | { allowed: true; spaceId: string }
  | { allowed: false; requestedSpace: string }

export function recordRequestSpaceDecision(
  requestedSpace: string,
  memberships: readonly RecordSpaceMembership[],
): RecordRequestSpaceDecision {
  const membership = recordSpaceMembership(requestedSpace, memberships)
  return membership
    ? { allowed: true, spaceId: membership.spaceId }
    : { allowed: false, requestedSpace }
}

/** Install destination authorization only on project and document operations. */
export function registerRecordRequestSpace(app: Hono<ApiEnvironment>): void {
  const requestedSpace = async (context: Context<ApiEnvironment>, next: Next) => {
    if (context.req.method === 'GET' && context.req.path === '/v1/docs/search') return next()
    const requested = context.req.header('x-record-space')
    if (!requested) return next()
    const decision = recordRequestSpaceDecision(
      requested,
      parseRecordSpaceMemberships(context.get('identity').memberships),
    )
    if (!decision.allowed) {
      return context.json(
        {
          error: `signed-in user is not a member of record space ${decision.requestedSpace}`,
          remedy: 'join that space with an invitation, then retry',
        },
        403,
      )
    }
    context.set('destinationSpaceId', decision.spaceId)
    await next()
  }
  app.use('/v1/projects', requestedSpace)
  app.use('/v1/projects/*', requestedSpace)
  app.use('/v1/docs', requestedSpace)
  app.use('/v1/docs/*', requestedSpace)
  app.use('/v1/settings/permission', requestedSpace)
}
