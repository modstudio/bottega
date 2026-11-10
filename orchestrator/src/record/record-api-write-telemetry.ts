// concern: record-api-write-telemetry
/** Records destination-less hosted writes and serves their authenticated health report. */

import type { Context, Hono } from 'hono'
import type { RecordIdentity } from './record-auth.ts'
import { noDestinationWriteCounter } from './record-no-destination-write-counter.ts'
import { destinationlessWrite } from './record-no-destination-write-decision.ts'

export type RecordWriteTelemetryEnvironment = {
  Variables: {
    identity: RecordIdentity
    destinationSpaceId?: string
    destinationlessWriteRecorded?: true
  }
}

export type RecordWriteTelemetryContext = Context<RecordWriteTelemetryEnvironment>

export function registerRecordWriteTelemetry(app: Hono<RecordWriteTelemetryEnvironment>): void {
  app.get('/v1/health/no-destination-writes', (context) =>
    context.json(
      noDestinationWriteCounter({
        read: context.get('identity').memberships.map((row) => String(row.space_id)),
      }),
    ),
  )
}

export function recordDestinationlessWrite(context: RecordWriteTelemetryContext): void {
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
