// concern: record-api-write-telemetry
/** Records destination-less hosted writes and serves their authenticated health report. */

import type { Context, Hono } from 'hono'
import {
  readNoDestinationWrites,
  recordNoDestinationWrite,
} from '../../../shared/record/no-destination-write-store.ts'
import { NO_DESTINATION_WRITES_ROUTE } from '../../../shared/record-no-destination-write-contract.ts'
import type { NoDestinationWriteTelemetry } from '../../../shared/record-no-destination-write-counter.ts'
import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import type { RecordIdentity } from './record-auth.ts'
import { destinationlessWrite } from './record-no-destination-write-decision.ts'

export type RecordWriteTelemetryEnvironment = {
  Variables: {
    identity: RecordIdentity
    writeTelemetry?: NoDestinationWriteTelemetry
    destinationSpaceId?: string
    destinationlessWriteRecorded?: true
  }
}

export type RecordWriteTelemetryContext = Context<RecordWriteTelemetryEnvironment>

export const RECORD_API_NO_DESTINATION_WRITE_SOURCE = 'api' as const

export function registerRecordWriteTelemetry(
  app: Hono<RecordWriteTelemetryEnvironment>,
  deps: NoDestinationWriteTelemetry,
): void {
  app.use('/v1/*', async (context, next) => {
    context.set('writeTelemetry', deps)
    await next()
  })
  app.get(NO_DESTINATION_WRITES_ROUTE, async (context) => {
    const identity = context.get('identity')
    const spaceIds = parseRecordSpaceMemberships(identity.memberships).map(
      (membership) => membership.spaceId,
    )
    return context.json(
      await deps.counter.read(spaceIds, () =>
        readNoDestinationWrites(
          deps.database(),
          { userId: identity.user.id, spaceId: identity.activeSpaceId ?? '', spaceIds },
          RECORD_API_NO_DESTINATION_WRITE_SOURCE,
        ),
      ),
    )
  })
}

export function recordDestinationlessWrite(context: RecordWriteTelemetryContext): void {
  const deps = context.get('writeTelemetry')
  if (!deps) throw new Error('destination-less write telemetry is not configured')
  const identity = context.get('identity')
  const decision = destinationlessWrite({
    method: context.req.method,
    destinationSpaceId: context.get('destinationSpaceId'),
    activeSpaceId: identity.activeSpaceId,
    route: context.req.routePath,
    userAgent: context.req.header('user-agent'),
  })
  if (!decision || context.get('destinationlessWriteRecorded')) return
  context.set('destinationlessWriteRecorded', true)
  void deps.counter.record(decision, () =>
    recordNoDestinationWrite(
      deps.database(),
      {
        userId: identity.user.id,
        spaceId: decision.spaceId,
      },
      decision,
      RECORD_API_NO_DESTINATION_WRITE_SOURCE,
    ),
  )
}
