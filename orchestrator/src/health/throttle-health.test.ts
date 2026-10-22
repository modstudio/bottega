import { expect, test } from 'bun:test'
import { bucketThrottles } from './throttle-health.ts'

test('throttles are bucketed by live codex concurrency', () => {
  expect(bucketThrottles([{ concurrency: 8 }, { concurrency: 6 }, { concurrency: 8 }])).toEqual([
    { concurrency: 6, throttles: 1 },
    { concurrency: 8, throttles: 2 },
  ])
})
