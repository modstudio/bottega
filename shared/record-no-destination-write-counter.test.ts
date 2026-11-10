import { expect, test } from 'bun:test'
import { noDestinationWriteCounter } from './record-no-destination-write-counter.ts'

test('counts by space, route and cause and filters reports by space', () => {
  const cause = `counter-test-${crypto.randomUUID()}`
  noDestinationWriteCounter({ record: { spaceId: 'space-a', route: '/a', cause } })
  noDestinationWriteCounter({ record: { spaceId: 'space-a', route: '/a', cause } })
  noDestinationWriteCounter({ record: { spaceId: 'space-b', route: '/b', cause } })

  expect(noDestinationWriteCounter({ read: ['space-a'] })?.counts).toContainEqual({
    spaceId: 'space-a',
    route: '/a',
    cause,
    occurrences: 2,
  })
  expect(noDestinationWriteCounter({ read: ['space-a'] })?.counts).not.toContainEqual(
    expect.objectContaining({ spaceId: 'space-b', cause }),
  )
})
