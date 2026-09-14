import { beforeEach, describe, expect, test } from 'bun:test'
import {
  GATE_CONCURRENCY_LIMIT, holdForGateCapacity, shouldHoldShard, withGateSlot,
} from './gate-load.ts'
import type { HostLoad } from './gate-policy.ts'
import { join } from 'node:path'
import { dir as suiteDir } from '../test/fixtures/store.ts'
import { trackedTestResidue } from '../test/residue.ts'
const trackResidue = trackedTestResidue()
beforeEach(() => { trackResidue(join(suiteDir, 'gates')) })

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

  test('withGateSlot holds then runs', async () => {
    let n = 0
    const sleeps: number[] = []
    const result = await withGateSlot(async () => 'ok', {
      // The measure reports OTHER runners; withGateSlot adds this one.
      measure: () => {
        n++
        return n === 1 ? idle({ gates: 2 }) : idle({ gates: 1 })
      },
      sleep: async (ms) => { sleeps.push(ms) },
      pollMs: 25,
      maxMs: 1_000,
    })
    expect(result).toBe('ok')
    expect(sleeps.length).toBeGreaterThan(0)
    expect(n).toBe(2)
  })
})

describe('gate slots under concurrency', () => {
  test('waiters do not count as runners: the third starter waits until one finishes', async () => {
    const { existsSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'orch-gate-slots-'))
    const pids = join(dir, 'pids')
    const module = new URL('./gate-load.ts', import.meta.url).href
    // Registration is per process, so each starter is its own process.
    const starter = (name: string, waitFor: string | null) => Bun.spawn([
      process.execPath, '-e',
      `const { writeFileSync, existsSync } = await import('node:fs');
       const { withGateSlot } = await import(process.argv[1]);
       const [dir, name, waitFor] = process.argv.slice(2);
       const measure = () => {
         const { measureHostLoad } = require(process.argv[1]);
         return { ...measureHostLoad(), loadavg: 0.2, ncpu: 8, freeMem: 8 * 1024 * 1024 * 1024 };
       };
       await withGateSlot(async () => {
         writeFileSync(dir + '/started-' + name, '');
         while (waitFor && !existsSync(waitFor)) await Bun.sleep(10);
       }, { measure, pollMs: 10, maxMs: 5_000, limit: 2 });`,
      module, dir, name, waitFor ?? '',
    ], { env: { ...process.env, ORCH_GATE_PIDS: pids }, stdout: 'pipe', stderr: 'pipe' })
    const release = join(dir, 'release')
    const a = starter('a', release)
    const b = starter('b', release)
    try {
      for (let i = 0; i < 300 && !(existsSync(join(dir, 'started-a')) && existsSync(join(dir, 'started-b'))); i++) {
        await Bun.sleep(10)
      }
      expect(existsSync(join(dir, 'started-a')) && existsSync(join(dir, 'started-b'))).toBe(true)
      const c = starter('c', null)
      await Bun.sleep(300)
      expect(existsSync(join(dir, 'started-c'))).toBe(false)
      writeFileSync(release, '')
      await Promise.all([a.exited, b.exited, c.exited])
      expect(existsSync(join(dir, 'started-c'))).toBe(true)
    } finally {
      writeFileSync(release, '')
      a.kill(); b.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
