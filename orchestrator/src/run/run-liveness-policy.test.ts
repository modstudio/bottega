import { describe, expect, test } from 'bun:test'
import {
  DETACHED_AGENT_CAPACITY_WAIT_MAX_MS,
  isRunQueuedForCapacity,
} from './run-liveness-policy.ts'

describe('run capacity queue policy', () => {
  const clock = Date.parse('2026-10-21T12:10:00.000Z')

  test('accepts an open agent capacity wait within its bound', () => {
    expect(
      isRunQueuedForCapacity('running', null, new Date(clock - 1_000).toISOString(), null, clock),
    ).toBe(true)
    expect(
      isRunQueuedForCapacity(
        'running',
        null,
        new Date(clock - DETACHED_AGENT_CAPACITY_WAIT_MAX_MS - 1).toISOString(),
        null,
        clock,
      ),
    ).toBe(false)
  })

  test('rejects a run with neither wait', () => {
    expect(isRunQueuedForCapacity('running', null, null, null, clock)).toBe(false)
  })

  test('rejects an agent wait after launch or outside running status', () => {
    const since = new Date(clock - 1_000).toISOString()
    expect(isRunQueuedForCapacity('running', null, since, 42, clock)).toBe(false)
    expect(isRunQueuedForCapacity('stopped', null, since, null, clock)).toBe(false)
  })
})
