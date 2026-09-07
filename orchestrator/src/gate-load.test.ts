import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  countRunningGates, GATE_CONCURRENCY_LIMIT, holdForGateCapacity, registerGatePid,
  shouldHoldShard,
} from './gate-load.ts'
import type { HostLoad } from './gate-policy.ts'

const idle = (over: Partial<HostLoad> = {}): HostLoad => ({
  gates: 1, loadavg: 0.2, ncpu: 8, freeMem: 8 * 1024 * 1024 * 1024, ...over,
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
      sleep: async (ms) => { sleeps.push(ms) },
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
      sleep: async () => { throw new Error('must not sleep under the limit') },
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

  test('PID files count live gates and reap stale ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-gates-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '1'), '1\n')
    const unregister = registerGatePid(process.pid, dir)
    try {
      expect(countRunningGates(dir, process.pid)).toBe(1)
    } finally {
      unregister()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
