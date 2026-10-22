import { expect, test } from 'bun:test'
import { firstThrottleObserver, replyFileFallbackError } from './run-live.ts'

test('a missing reply file leaves a visible final-message fallback notice', () => {
  const path = '/var/tmp/orch/runs/42/scratch/reply.json'
  expect(replyFileFallbackError(path, false, null)).toBe(
    `reply.json missing at ${path}; used final-message fallback`,
  )
  expect(replyFileFallbackError(path, true, null)).toBeNull()
})

test('the first live throttle cancels exactly once', () => {
  let cancellations = 0
  const throttle = firstThrottleObserver(() => cancellations++)
  const event = {
    kind: 'throttled' as const,
    attempt: 1,
    max: 5,
    retryDelayMs: 225_000,
    retryAt: '2026-10-21T20:03:45.000Z',
    httpStatus: 429 as const,
  }
  throttle.observe(event)
  throttle.observe({ ...event, attempt: 2 })
  expect(cancellations).toBe(1)
  expect(throttle.state.first).toEqual(event)
})
