// concern: record-api-client-transport
/** Owns the recorded transport choke point for record API HTTP calls. */

import { hostedApiFetch } from '../../../shared/bounded-fetch.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { scheduleHostedCallObservation } from '../../../shared/hosted-call-observation.ts'
import { runningInstallationIdentity } from '../../../shared/install-root.ts'
import { recordRouteClass, tracedRecordFetch } from '../../../shared/record-call-trace.ts'
import { recordRequestHeaders } from '../../../shared/record-request-headers.ts'
import {
  classifyHostedTransportError,
  type HostedCallOutcomeRecorder,
  recordHostedCallOutcome,
} from '../hosted-call-outcome.ts'

let memoizedUserAgent: string | undefined

function runningInstallationUserAgent(): string {
  const identity = runningInstallationIdentity(import.meta.dir, process.env)
  const version = identity.kind === 'distribution' ? identity.manifest.version : identity.version
  return `${PLATFORM_SLUG}/${version}`
}

function userAgentFrom(identityResolver: () => string): string {
  try {
    return identityResolver()
  } catch {
    return `${PLATFORM_SLUG}/unknown`
  }
}

/** The running installation's user-agent, resolved once per process. */
function runningUserAgent(): string {
  memoizedUserAgent ??= userAgentFrom(runningInstallationUserAgent)
  return memoizedUserAgent
}

export async function recordTransport(
  baseUrl: string,
  path: string,
  init: RequestInit,
  transport: typeof fetch = hostedApiFetch,
  recorder: HostedCallOutcomeRecorder = recordHostedCallOutcome,
  identityResolver?: () => string,
): Promise<Response> {
  const startedAt = performance.now()
  const userAgent = identityResolver ? userAgentFrom(identityResolver) : runningUserAgent()
  try {
    const headers = recordRequestHeaders({ headers: init.headers })
    headers.set('user-agent', userAgent)
    const response = await tracedRecordFetch(`${baseUrl}${path}`, { ...init, headers }, transport)
    scheduleHostedCallObservation(recorder, {
      observedAt: new Date().toISOString(),
      routeClass: recordRouteClass(path),
      httpStatus: response.status,
      transportError: null,
      latencyMs: performance.now() - startedAt,
    })
    return response
  } catch (error) {
    scheduleHostedCallObservation(recorder, {
      observedAt: new Date().toISOString(),
      routeClass: recordRouteClass(path),
      httpStatus: null,
      transportError: classifyHostedTransportError(error),
      latencyMs: performance.now() - startedAt,
    })
    throw error
  }
}

export function boardStreamHeaders(token: string): Headers {
  const headers = new Headers()
  for (const [name, value] of recordRequestHeaders({ bearerToken: token })) headers.set(name, value)
  headers.set('accept', 'text/event-stream')
  return headers
}
