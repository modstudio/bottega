import { describe, expect, test } from 'bun:test'
import { type RunLeaseState, recordedRunLivenessFacts, runAlive } from './run-alive.ts'

describe('runAlive', () => {
  test('a live owner process outranks an old session stamp until the persisted bound', () => {
    const now = Date.parse('2026-10-26T12:00:00.000Z')
    expect(
      recordedRunLivenessFacts(
        {
          executor: 'harness',
          session_last_seen: '2026-10-26T10:00:00.000Z',
          started_at: '2026-10-26T11:15:00.000Z',
          harness_wall_bound_ms: 60 * 60 * 1000,
        },
        now,
        60 * 60 * 1000,
        'live',
      ),
    ).toEqual({ executor: 'harness', ownerSessionAlive: true, wallBoundExceeded: false })
  })
  test('a harness run follows its owner session until its wall bound', () => {
    expect(
      runAlive({
        status: 'running',
        lease: 'missing',
        pidAlive: false,
        executor: 'harness',
        ownerSessionAlive: true,
        wallBoundExceeded: false,
      }),
    ).toBe(true)
    expect(
      runAlive({
        status: 'running',
        lease: 'missing',
        pidAlive: false,
        executor: 'harness',
        ownerSessionAlive: false,
        wallBoundExceeded: false,
      }),
    ).toBe(false)
    expect(
      runAlive({
        status: 'running',
        lease: 'missing',
        pidAlive: false,
        executor: 'harness',
        ownerSessionAlive: true,
        wallBoundExceeded: true,
      }),
    ).toBe(false)
  })
  test('unknown owner process evidence falls back to a fresh session stamp', () => {
    const now = Date.parse('2026-10-26T12:00:00.000Z')
    expect(
      recordedRunLivenessFacts(
        {
          executor: 'harness',
          session_last_seen: '2026-10-26T11:59:00.000Z',
          started_at: '2026-10-26T11:45:00.000Z',
          harness_wall_bound_ms: 30 * 60_000,
        },
        now,
        5 * 60_000,
        'unknown',
      ),
    ).toEqual({ executor: 'harness', ownerSessionAlive: true, wallBoundExceeded: false })
  })
  test.each([
    ['asking', 'held', false, true],
    ['asking', 'free', false, true],
    ['asking', 'missing', false, true],
    ['running', 'held', false, true],
    ['running', 'free', true, false],
    ['running', 'missing', true, true],
    ['running', 'missing', false, false],
    ['ok', 'held', true, false],
    ['failed', 'held', true, false],
    ['stale', 'held', true, false],
    ['stopped', 'held', true, false],
  ] as const)('%s with a %s lease and pidAlive=%s is %s', (status, lease, pid, alive) => {
    expect(runAlive({ status, lease: lease as RunLeaseState, pidAlive: pid })).toBe(alive)
  })
})
