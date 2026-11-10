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
import { destinationlessWrite } from './record-no-destination-write-decision.ts'
import { noDestinationWriteCounter } from './record-no-destination-write-counter.ts'

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
    try {
      await next()
    } finally {
      recordDestinationlessWrite(context)
    }
  }
  app.get('/v1/health/no-destination-writes', (context) =>
    context.json(
      noDestinationWriteCounter({
        read: context.get('identity').memberships.map((row) => String(row.space_id)),
      }),
    ),
  )
  app.use('/v1/projects', requestedSpace)
  app.use('/v1/projects/*', requestedSpace)
  app.use('/v1/releases', requestedSpace)
  app.use('/v1/releases/*', requestedSpace)
  app.use('/v1/docs', requestedSpace)
  app.use('/v1/docs/*', requestedSpace)
  app.use('/v1/subjects', requestedSpace)
  app.use('/v1/subjects/*', requestedSpace)
  app.use('/v1/lens-catalogue', requestedSpace)
  app.use('/v1/lens-catalogue/*', requestedSpace)
  app.use('/v1/workflow-catalogue', requestedSpace)
  app.use('/v1/workflow-catalogue/*', requestedSpace)
  app.use('/v1/task-flow', requestedSpace)
  app.use('/v1/port-catalogue', requestedSpace)
  app.use('/v1/port-catalogue/*', requestedSpace)
  app.use('/v1/settings/permission', requestedSpace)
  app.use('/v1/settings/auto-mode', requestedSpace)
  app.use('/v1/config/*', requestedSpace)
  app.use('/v1/runs/*', requestedSpace)
  app.use('/v1/snapshots', requestedSpace)
  app.use('/v1/snapshots/*', requestedSpace)
}

export function recordDestinationlessWrite(context: Context<ApiEnvironment>): void {
  const identity = context.get('identity')
  const decision = destinationlessWrite({
    method: context.req.method,
    destinationSpaceId: context.get('destinationSpaceId'),
    activeSpaceId: identity.activeSpaceId,
    route: context.req.routePath,
    userAgent: context.req.header('user-agent'),
  })
  if (!decision) return
  try {
    noDestinationWriteCounter({ record: decision })
  } catch (error) {
    queueMicrotask(() => {
      try {
        console.error('record-write no-destination recording failed', error)
      } catch {}
    })
  }
}
