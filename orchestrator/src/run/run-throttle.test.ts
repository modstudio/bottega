import { expect, test } from 'bun:test'
import { composeCodexThrottleNotice } from '../transport/codex-throttle.ts'
import { throttleReplyError } from './run-throttle.ts'

test('a throttle notice takes precedence over collected reply errors', () => {
  const throttle = {
    kind: 'throttled' as const,
    attempt: 1,
    max: 5,
    retryDelayMs: 225_000,
    retryAt: '2026-10-21T20:03:45.000Z',
    httpStatus: 429 as const,
  }
  expect(throttleReplyError(throttle, 'reply failed', 'collection failed')).toBe(
    composeCodexThrottleNotice(throttle),
  )
})

test('without a throttle the reply error falls back to the collected error', () => {
  expect(throttleReplyError(null, 'reply failed', 'collection failed')).toBe('reply failed')
  expect(throttleReplyError(null, null, 'collection failed')).toBe('collection failed')
})
