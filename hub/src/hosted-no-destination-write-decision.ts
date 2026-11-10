// concern: hosted-no-destination-write-decision
/** Decides whether a hosted hub request wrote through the caller's active-space fallback. */

import { recordRequestNature } from '../../shared/record-space-request.ts'

export const HOSTED_NO_DESTINATION_CAUSE_LENGTH = 200
const UNLISTED_HOSTED_WRITE_ROUTE = '(unlisted)'

const hostedWriteRoutes = [
  ['POST', /^\/v1\/tasks$/, '/v1/tasks'],
  ['POST', /^\/v1\/tasks\/[^/]+\/documents$/, '/v1/tasks/:key/documents'],
  ['POST', /^\/v1\/notes$/, '/v1/notes'],
  ['POST', /^\/v1\/notes\/outside$/, '/v1/notes/outside'],
  ['POST', /^\/v1\/notes\/[^/]+\/promote$/, '/v1/notes/:id/promote'],
  ['POST', /^\/v1\/notes\/reap$/, '/v1/notes/reap'],
  ['PUT', /^\/v1\/notes\/mirror$/, '/v1/notes/mirror'],
  ['POST', /^\/v1\/changes$/, '/v1/changes'],
  ['POST', /^\/v1\/tasks\/presence$/, '/v1/tasks/presence'],
  ['DELETE', /^\/v1\/tasks$/, '/v1/tasks'],
  ['POST', /^\/v1\/sends$/, '/v1/sends'],
  ['PUT', /^\/v1\/sends\/mirror$/, '/v1/sends/mirror'],
  ['POST', /^\/v1\/report-subscriptions$/, '/v1/report-subscriptions'],
  ['PUT', /^\/v1\/report-subscriptions\/[^/]+$/, '/v1/report-subscriptions/:id'],
  ['DELETE', /^\/v1\/report-subscriptions\/[^/]+$/, '/v1/report-subscriptions/:id'],
  ['POST', /^\/v1\/operator-waiting-emails$/, '/v1/operator-waiting-emails'],
] as const

function hostedWriteRoute(method: string, pathname: string): string {
  return (
    hostedWriteRoutes.find(
      ([routeMethod, pattern]) => routeMethod === method.toUpperCase() && pattern.test(pathname),
    )?.[2] ?? UNLISTED_HOSTED_WRITE_ROUTE
  )
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
  if (input.requestedSpacePresent && input.routeHonorsRequestedSpace) return { counted: false }
  return { counted: true, route: hostedWriteRoute(input.method, input.pathname) }
}
