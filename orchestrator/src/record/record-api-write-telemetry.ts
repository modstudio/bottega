// concern: record-api-write-telemetry
/** Records destination-less hosted writes and serves their authenticated health report. */

import type { Context, Hono } from 'hono'
import { NO_DESTINATION_WRITES_ROUTE } from '../../../shared/record-no-destination-write-contract.ts'
import {
  createNoDestinationWriteCounter,
  type NoDestinationWriteCounter,
} from '../../../shared/record-no-destination-write-counter.ts'
import {
  readNoDestinationWrites,
  recordNoDestinationWrite,
} from '../../../shared/record-no-destination-write-store.ts'
import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import type { RecordIdentity } from './record-auth.ts'
import { destinationlessWrite } from './record-no-destination-write-decision.ts'
import { recordPool } from './record-pool.ts'

export type RecordWriteTelemetryEnvironment = {
  Variables: {
    identity: RecordIdentity
    writeTelemetry?: { recordUrl: string; counter: NoDestinationWriteCounter }
    destinationSpaceId?: string
    destinationlessWriteRecorded?: true
  }
}

export type RecordWriteTelemetryContext = Context<RecordWriteTelemetryEnvironment>

const counters = new Map<string, NoDestinationWriteCounter>()

function counterFor(recordUrl: string): NoDestinationWriteCounter {
  const existing = counters.get(recordUrl)
  if (existing) return existing
  const counter = createNoDestinationWriteCounter()
  counters.set(recordUrl, counter)
  return counter
}

export function registerRecordWriteTelemetry(
  app: Hono<RecordWriteTelemetryEnvironment>,
  deps: { recordUrl: string; counter?: NoDestinationWriteCounter },
): void {
  const writeTelemetry = {
    recordUrl: deps.recordUrl,
    counter: deps.counter ?? counterFor(deps.recordUrl),
  }
  app.use('/v1/*', async (context, next) => {
    context.set('writeTelemetry', writeTelemetry)
    await next()
  })
  app.get(NO_DESTINATION_WRITES_ROUTE, async (context) => {
    const identity = context.get('identity')
    const spaceIds = parseRecordSpaceMemberships(identity.memberships).map(
      (membership) => membership.spaceId,
    )
    return context.json(
      await writeTelemetry.counter.read(spaceIds, () =>
        readNoDestinationWrites(recordPool(deps.recordUrl), {
          userId: identity.user.id,
          spaceId: identity.activeSpaceId ?? '',
          spaceIds,
        }),
      ),
    )
  })
}

export function recordDestinationlessWrite(
  context: RecordWriteTelemetryContext,
  fallback?: { recordUrl: string },
): void {
  const deps =
    context.get('writeTelemetry') ??
    (fallback
      ? { recordUrl: fallback.recordUrl, counter: counterFor(fallback.recordUrl) }
      : undefined)
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
      recordPool(deps.recordUrl),
      {
        userId: identity.user.id,
        spaceId: decision.spaceId,
      },
      decision,
    ),
  )
}
