import { beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { dir as suiteDir } from '../test/fixtures/store.ts'
import { trackedTestResidue } from '../test/residue.ts'
import type { HostLoad } from './gate-load.ts'
import {
  GATE_CONCURRENCY_LIMIT,
  holdForGateCapacity,
  shouldHoldShard,
  withGateSlot,
} from './gate-load.ts'

const trackResidue = trackedTestResidue()
beforeEach(() => {
  trackResidue(join(suiteDir, 'gates'))
})

const idle = (over: Partial<HostLoad> = {}): HostLoad => ({
  gates: 1,
  loadavg: 0.2,
  ncpu: 8,
  freeMem: 8 * 1024 * 1024 * 1024,
  ...over,
})

describe('gate load hold', () => {
  test('the load hold delays a shard', async () => {
    let n = 0
    const sleeps: number[] = []
    const result = await holdForGateCapacity({
      measure: () => {
        n++
        return n === 1 ? idle({ gates: 3 }) : idle({ gates: 1 })
      },
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      pollMs: 25,
      maxMs: 1_000,
    })
    expect(result.held).toBe(true)
    expect(result.delayedMs).toBeGreaterThan(0)
    expect(sleeps.length).toBeGreaterThan(0)
    expect(n).toBe(2)
  })

  test('two concurrent gates do not hold a shard', async () => {
    const result = await holdForGateCapacity({
      measure: () => idle({ gates: GATE_CONCURRENCY_LIMIT }),
      sleep: async () => {
        throw new Error('must not sleep under the limit')
      },
    })
    expect(result.held).toBe(false)
    expect(result.delayedMs).toBe(0)
  })

  test('CPU and memory floors hold even with one gate', () => {
    expect(shouldHoldShard(idle({ gates: 1, loadavg: 8, ncpu: 8 }))).toBe(true)
    expect(shouldHoldShard(idle({ gates: 1, freeMem: 512 * 1024 * 1024 }))).toBe(true)
    expect(shouldHoldShard(idle({ gates: 2 }))).toBe(false)
    expect(shouldHoldShard(idle({ gates: 3 }))).toBe(true)
  })

  test('withGateSlot holds then runs', async () => {
    let n = 0
    const sleeps: number[] = []
    const result = await withGateSlot(async () => 'ok', {
      env: { ...process.env, CI: undefined },
      // The measure reports OTHER runners; withGateSlot adds this one.
      measure: () => {
        n++
        return n === 1 ? idle({ gates: 2 }) : idle({ gates: 1 })
      },
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      pollMs: 25,
      maxMs: 1_000,
    })
    expect(result).toBe('ok')
    expect(sleeps.length).toBeGreaterThan(0)
    expect(n).toBe(2)
  })

  test('withGateSlot does not hold for host load under CI', async () => {
    const result = await withGateSlot(async () => 'ok', {
      env: { ...process.env, CI: '1' },
      measure: () => idle({ gates: 3, loadavg: 8, ncpu: 8 }),
      sleep: async () => {
        throw new Error('must not sleep under CI')
      },
    })
    expect(result).toBe('ok')
  })
})

describe('gate slots under concurrency', () => {})
