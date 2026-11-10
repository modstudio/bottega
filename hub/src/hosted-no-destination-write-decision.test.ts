import { expect, test } from 'bun:test'
import { hostedNoDestinationWriteDecision } from './hosted-no-destination-write-decision.ts'

const input = {
  method: 'POST',
  requestedSpacePresent: false,
  routeHonorsRequestedSpace: true,
  identityOutcome: 'authenticated' as const,
  pathname: '/v1/tasks/example/documents',
}

test('counts only authenticated writes that resolve through the active-space fallback', () => {
  expect(hostedNoDestinationWriteDecision(input)).toEqual({
    counted: true,
    route: '/v1/tasks/:key/documents',
  })
  expect(hostedNoDestinationWriteDecision({ ...input, requestedSpacePresent: true })).toEqual({
    counted: false,
  })
  expect(
    hostedNoDestinationWriteDecision({
      ...input,
      requestedSpacePresent: true,
      routeHonorsRequestedSpace: false,
    }),
  ).toEqual({ counted: true, route: '/v1/tasks/:key/documents' })
  for (const method of ['GET', 'HEAD'])
    expect(hostedNoDestinationWriteDecision({ ...input, method })).toEqual({ counted: false })
  for (const identityOutcome of ['refused-space', 'unauthenticated', 'unavailable'] as const)
    expect(hostedNoDestinationWriteDecision({ ...input, identityOutcome })).toEqual({
      counted: false,
    })
})

test('uses declared route patterns and marks unknown write paths', () => {
  expect(
    hostedNoDestinationWriteDecision({ ...input, pathname: '/v1/tasks/DEV-1/documents' }),
  ).toEqual({ counted: true, route: '/v1/tasks/:key/documents' })
  expect(hostedNoDestinationWriteDecision({ ...input, pathname: '/v1/unknown' })).toEqual({
    counted: true,
    route: '(unlisted)',
  })
})
