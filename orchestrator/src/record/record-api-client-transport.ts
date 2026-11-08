// concern: record-api-client-transport
/** Owns the recorded transport choke point for record API HTTP calls. */

import { hostedApiFetch } from '../../../shared/bounded-fetch.ts'
import { scheduleHostedCallObservation } from '../../../shared/hosted-call-observation.ts'
import {
  classifyHostedTransportError,
  type HostedCallOutcomeRecorder,
  recordHostedCallOutcome,
} from '../hosted-call-outcome.ts'
import { bearerHeaders } from './record-auth.ts'

function recordHostedRouteClass(path: string): string {
  const pathname = path.split('?', 1)[0] ?? path
  if (pathname.startsWith('/api/auth/')) return 'record-auth'
  if (pathname.startsWith('/public/v1/docs')) return 'record-public-docs'
  if (pathname.startsWith('/v1/board/stream')) return 'record-board-stream'
  const family = pathname.match(/^\/v1\/([^/]+)/)?.[1]
  const known = new Set([
    'board',
    'catalogues',
    'changes',
    'config-access',
    'docs',
    'invitations',
    'lens-catalogue',
    'machine',
    'outside-blocks',
    'outside-intake',
    'port-catalogue',
    'projects',
    'routing-evidence',
    'runs',
    'scores',
    'settings',
    'snapshots',
    'spaces',
    'storage',
    'subjects',
    'sync',
    'task-flow',
    'whoami',
    'workflow-catalogue',
  ])
  return family && known.has(family) ? `record-${family}` : 'record-other'
}

export async function recordTransport(
  baseUrl: string,
  path: string,
  init: RequestInit,
  transport: typeof fetch = hostedApiFetch,
  recorder: HostedCallOutcomeRecorder = recordHostedCallOutcome,
): Promise<Response> {
  const startedAt = performance.now()
  try {
    const response = await transport(`${baseUrl}${path}`, init)
    scheduleHostedCallObservation(recorder, {
      observedAt: new Date().toISOString(),
      routeClass: recordHostedRouteClass(path),
      httpStatus: response.status,
      transportError: null,
      latencyMs: performance.now() - startedAt,
    })
    return response
  } catch (error) {
    scheduleHostedCallObservation(recorder, {
      observedAt: new Date().toISOString(),
      routeClass: recordHostedRouteClass(path),
      httpStatus: null,
      transportError: classifyHostedTransportError(error),
      latencyMs: performance.now() - startedAt,
    })
    throw error
  }
}

export function boardStreamHeaders(token: string): Headers {
  const headers = new Headers()
  for (const [name, value] of bearerHeaders(token)) headers.set(name, value)
  headers.set('accept', 'text/event-stream')
  return headers
}
