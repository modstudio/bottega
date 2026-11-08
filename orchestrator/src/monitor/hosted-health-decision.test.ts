import { describe, expect, test } from 'bun:test'
import {
  HOSTED_DEGRADED_LATENCY_MS,
  HOSTED_DEGRADED_MIN_CALLS,
  HOSTED_DEGRADED_SHARE,
  HOSTED_HEALTH_WINDOW_MS,
  HOSTED_UNREACHABLE_MIN_FAILURES,
  type HostedHealthOutcome,
  hostedHealthFromOutcomes,
} from './hosted-health-decision.ts'

const now = Date.parse('2026-11-08T12:00:00.000Z')
const outcome = (
  secondsAgo: number,
  input: Partial<HostedHealthOutcome> = {},
): HostedHealthOutcome => ({
  observedAt: new Date(now - secondsAgo * 1_000).toISOString(),
  httpStatus: 200,
  transportError: null,
  latencyMs: 20,
  ...input,
})

describe('hostedHealthFromOutcomes', () => {
  test('three consecutive transport errors are unreachable', () => {
    const decision = hostedHealthFromOutcomes(
      Array.from({ length: HOSTED_UNREACHABLE_MIN_FAILURES }, (_, index) =>
        outcome(HOSTED_UNREACHABLE_MIN_FAILURES - index, {
          httpStatus: null,
          transportError: 'dns',
        }),
      ),
      now,
    )
    expect(decision).toEqual({
      health: 'unreachable',
      counts: { calls: 3, failures: 3, slow: 0, recentFailures: 3 },
      latestSuccess: false,
    })
  })

  test('three consecutive 503 responses are unreachable', () => {
    expect(
      hostedHealthFromOutcomes(
        [3, 2, 1].map((age) => outcome(age, { httpStatus: 503 })),
        now,
      ).health,
    ).toBe('unreachable')
  })

  test('a later success clears unreachable', () => {
    const calls = [4, 3, 2].map((age) => outcome(age, { httpStatus: 503 }))
    calls.push(outcome(1))
    expect(hostedHealthFromOutcomes(calls, now)).toMatchObject({
      health: 'healthy',
      counts: { failures: 3, recentFailures: 0 },
    })
  })

  test('a slow majority is degraded', () => {
    const slowCount = Math.ceil(HOSTED_DEGRADED_MIN_CALLS * HOSTED_DEGRADED_SHARE)
    const calls = Array.from({ length: HOSTED_DEGRADED_MIN_CALLS }, (_, index) =>
      outcome(HOSTED_DEGRADED_MIN_CALLS - index, {
        latencyMs: index < slowCount ? HOSTED_DEGRADED_LATENCY_MS + 1 : 20,
      }),
    )
    expect(hostedHealthFromOutcomes(calls, now)).toMatchObject({
      health: 'degraded',
      counts: { calls: HOSTED_DEGRADED_MIN_CALLS, slow: slowCount },
    })
  })

  test('enough fast round trips are healthy', () => {
    expect(
      hostedHealthFromOutcomes(
        [5, 4, 3, 2, 1].map((age) => outcome(age)),
        now,
      ).health,
    ).toBe('healthy')
  })

  test('too few calls are unknown', () => {
    expect(
      hostedHealthFromOutcomes([outcome(HOSTED_HEALTH_WINDOW_MS / 1_000 - 1)], now).health,
    ).toBe('unknown')
  })

  test('a 4xx response is a healthy round trip', () => {
    const calls = [5, 4, 3, 2].map((age) => outcome(age))
    calls.push(outcome(1, { httpStatus: 404 }))
    expect(hostedHealthFromOutcomes(calls, now)).toEqual({
      health: 'healthy',
      counts: { calls: 5, failures: 0, slow: 0, recentFailures: 0 },
      latestSuccess: true,
    })
  })
})
