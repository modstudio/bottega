// concern: record-api-write-telemetry
/** Records destination-less hosted writes and serves their authenticated health report. */

import type { SQL } from 'bun'
import type { Context, Hono } from 'hono'
import { NO_DESTINATION_WRITES_ROUTE } from '../../../shared/record-no-destination-write-contract.ts'
import type { NoDestinationWriteCounter } from '../../../shared/record-no-destination-write-counter.ts'
import {
  readNoDestinationWrites,
  recordNoDestinationWrite,
} from '../../../shared/record-no-destination-write-store.ts'
import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import type { RecordIdentity } from './record-auth.ts'
import { destinationlessWrite } from './record-no-destination-write-decision.ts'

export type RecordWriteTelemetryEnvironment = {
  Variables: {
    identity: RecordIdentity
    writeTelemetry?: { database: SQL; counter: NoDestinationWriteCounter }
    destinationSpaceId?: string
    destinationlessWriteRecorded?: true
  }
}

export type RecordWriteTelemetryContext = Context<RecordWriteTelemetryEnvironment>

export function registerRecordWriteTelemetry(
  app: Hono<RecordWriteTelemetryEnvironment>,
  deps: { database?: SQL; counter?: NoDestinationWriteCounter },
): void {
  const writeTelemetry =
    deps.database && deps.counter ? { database: deps.database, counter: deps.counter } : undefined
  app.use('/v1/*', async (context, next) => {
    if (writeTelemetry) context.set('writeTelemetry', writeTelemetry)
    await next()
  })
  app.get(NO_DESTINATION_WRITES_ROUTE, async (context) => {
    const identity = context.get('identity')
    const spaceIds = parseRecordSpaceMemberships(identity.memberships).map(
      (membership) => membership.spaceId,
    )
    return context.json(
      await writeTelemetry!.counter.read(spaceIds, () =>
        readNoDestinationWrites(
          writeTelemetry!.database,
          { userId: identity.user.id, spaceId: identity.activeSpaceId ?? '', spaceIds },
          'api',
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
      deps.database,
      {
        userId: identity.user.id,
        spaceId: decision.spaceId,
      },
      decision,
      'api',
    ),
  )
}
