// concern: hosted-no-destination-write-api
/** Authenticates and serves the process-local hosted hub destination-less write report. */

import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { NO_DESTINATION_WRITES_ROUTE } from '../../shared/record-no-destination-write-contract.ts'
import { noDestinationWriteCounter } from '../../shared/record-no-destination-write-counter.ts'
import type { HostedRouteConfig } from './hosted-route-config.ts'
import {
  assertAuthenticatedIdentity,
  identityRefusal,
  taskSpaceIdentity,
} from './hosted-route-identity.ts'

export type HostedNoDestinationWriteDependencies = {
  fetch?: typeof fetch
  counter?: typeof noDestinationWriteCounter
}

export async function hostedNoDestinationWriteApi(
  request: Request,
  config: HostedRouteConfig,
  dependencies: HostedNoDestinationWriteDependencies = {},
): Promise<Response | null> {
  if (request.method !== 'GET' || new URL(request.url).pathname !== NO_DESTINATION_WRITES_ROUTE)
    return null
  const identity = await taskSpaceIdentity(
    request,
    config.recordApiUrl,
    dependencies.fetch ?? fetch,
    true,
  )
  const refusal = identityRefusal(identity)
  if (refusal) return refusal
  if (identity.kind === 'refused-space')
    return Response.json(
      {
        error: `record space '${identity.refusedSpace}' is not among the caller's memberships`,
        remedy: `Run \`${PLATFORM_SLUG} record space list\` and choose a space where the caller is a member.`,
      },
      { status: 403 },
    )
  assertAuthenticatedIdentity(identity)
  return Response.json(
    (dependencies.counter ?? noDestinationWriteCounter)({ read: identity.spaceIds }),
  )
}
