import { describe, expect, test } from 'bun:test'
import { type RunLeaseState, runAlive } from './run-alive.ts'

describe('runAlive', () => {
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
