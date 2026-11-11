// concern: hosted-no-destination-write-api
/** Authenticates and serves the process-local hosted hub destination-less write report. */

import { hostedApiFetch } from '../../shared/bounded-fetch.ts'
import { readNoDestinationWrites } from '../../shared/record/no-destination-write-store.ts'
import { NO_DESTINATION_WRITES_ROUTE } from '../../shared/record-no-destination-write-contract.ts'
import type { NoDestinationWriteCounter } from '../../shared/record-no-destination-write-counter.ts'
import type { HostedRouteConfig } from './hosted-route-config.ts'
import {
  assertAuthenticatedIdentity,
  HUB_NO_DESTINATION_WRITE_SOURCE,
  identityRefusal,
  refusedSpaceResponse,
  taskSpaceIdentity,
} from './hosted-route-identity.ts'

export type HostedNoDestinationWriteDependencies = {
  fetch?: typeof fetch
  counter?: NoDestinationWriteCounter
}

export async function hostedNoDestinationWriteApi(
  request: Request,
  config: HostedRouteConfig,
  dependencies: HostedNoDestinationWriteDependencies = {},
): Promise<Response | null> {
  if (request.method !== 'GET' || new URL(request.url).pathname !== NO_DESTINATION_WRITES_ROUTE)
    return null
  const noDestinationWrite = {
    counter: dependencies.counter ?? config.noDestinationWriteCounter,
    database: config.recordDatabaseUrl,
  }
  const identity = await taskSpaceIdentity(
    request,
    config.recordApiUrl,
    dependencies.fetch ?? hostedApiFetch,
    true,
    noDestinationWrite,
  )
  const refusal = identityRefusal(identity)
  if (refusal) return refusal
  if (identity.kind === 'refused-space') return refusedSpaceResponse(identity.refusedSpace)
  assertAuthenticatedIdentity(identity)
  return Response.json(
    await noDestinationWrite.counter.read(identity.spaceIds, () =>
      readNoDestinationWrites(
        config.recordDatabaseUrl,
        { userId: identity.userId, spaceId: identity.spaceId, spaceIds: identity.spaceIds },
        HUB_NO_DESTINATION_WRITE_SOURCE,
      ),
    ),
  )
}
