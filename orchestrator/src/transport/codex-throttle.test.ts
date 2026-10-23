import { expect, test } from 'bun:test'
import { classifyCodexThrottle } from './codex-throttle.ts'

test('classifies the first stderr retry warning with its delay', () => {
  expect(
    classifyCodexThrottle(
      '2026-10-21T20:00:00Z WARN codex_core: retrying sampling request (1/5 in 224.999951542s) ... last status: 429 Too Many Requests',
    ),
  ).toEqual({ attempt: 1, max: 5, retryDelayMs: 225_000, status: 429 })
})

test('classifies the stdout reconnect error without inventing a delay', () => {
  expect(
    classifyCodexThrottle(
      JSON.stringify({
        type: 'error',
        message: 'Reconnecting... 2/5 (exceeded retry limit, last status: 429 Too Many Requests)',
      }),
    ),
  ).toEqual({ attempt: 2, max: 5, retryDelayMs: null, status: 429 })
})

test('does not classify unrelated warnings or prose', () => {
  expect(classifyCodexThrottle('WARN retrying sampling request (1/5 in 2s): timeout')).toBeNull()
  expect(classifyCodexThrottle('{"type":"message","message":"Reconnecting... 1/5 429"}')).toBeNull()
})
