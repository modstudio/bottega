// concern: hosted-no-destination-write-decision
/** Decides whether a hosted hub request wrote through the caller's active-space fallback. */

import { recordRequestNature } from '../../shared/record-space-request.ts'
import { registeredHostedWriteRoute } from './hosted-write-routes.ts'

export function hostedWriteIsExempt(method: string, pathname: string): boolean {
  return registeredHostedWriteRoute(method, pathname)?.destination === 'exempt'
}

const UNLISTED_HOSTED_WRITE_ROUTE = '(unlisted)'

function hostedWriteRoute(method: string, pathname: string): string {
  return registeredHostedWriteRoute(method, pathname)?.path ?? UNLISTED_HOSTED_WRITE_ROUTE
}

export function hostedNoDestinationWriteDecision(input: {
  method: string
  requestedSpacePresent: boolean
  routeHonorsRequestedSpace: boolean
  identityOutcome: 'authenticated' | 'refused-space' | 'unauthenticated' | 'unavailable'
  pathname: string
}): { counted: false } | { counted: true; route: string } {
  if (recordRequestNature(input.method) === 'read' || input.identityOutcome !== 'authenticated')
    return { counted: false }
  if (hostedWriteIsExempt(input.method, input.pathname)) return { counted: false }
  if (input.requestedSpacePresent && input.routeHonorsRequestedSpace) return { counted: false }
  return { counted: true, route: hostedWriteRoute(input.method, input.pathname) }
}
