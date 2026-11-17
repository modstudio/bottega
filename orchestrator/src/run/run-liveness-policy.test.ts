import { describe, expect, test } from 'bun:test'
import {
  DETACHED_AGENT_CAPACITY_WAIT_MAX_MS,
  isRunQueuedForCapacity,
  RUN_HOST_WAIT_MAX_MS,
  RUN_HOST_WAIT_POLL_MS,
} from './run-liveness-policy.ts'

describe('run capacity queue policy', () => {
  const clock = Date.parse('2026-10-21T12:10:00.000Z')

  test('accepts a fresh host wait', () => {
    expect(isRunQueuedForCapacity(new Date(clock - 1_000).toISOString(), null, clock)).toBe(true)
    expect(
      isRunQueuedForCapacity(
        new Date(clock - RUN_HOST_WAIT_MAX_MS - RUN_HOST_WAIT_POLL_MS - 1).toISOString(),
        null,
        clock,
      ),
    ).toBe(false)
  })

  test('accepts an open agent capacity wait within its bound', () => {
    expect(isRunQueuedForCapacity(null, new Date(clock - 1_000).toISOString(), clock)).toBe(true)
    expect(
      isRunQueuedForCapacity(
        null,
        new Date(clock - DETACHED_AGENT_CAPACITY_WAIT_MAX_MS - 1).toISOString(),
        clock,
      ),
    ).toBe(false)
  })

  test('rejects a run with neither wait and a closed agent wait', () => {
    expect(isRunQueuedForCapacity(null, null, clock)).toBe(false)
    const closedAgentWaitSince = null
    expect(isRunQueuedForCapacity(null, closedAgentWaitSince, clock)).toBe(false)
  })
})
