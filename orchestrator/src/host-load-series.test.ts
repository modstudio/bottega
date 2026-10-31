import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_HOME_ENV } from '../../shared/state-directory.ts'
import { dir as suiteDir } from '../test/fixtures/store.ts'
import { trackedTestResidue } from '../test/residue.ts'
import { db } from './database/db.ts'
import { type HostLoad, measureHostLoad } from './gate-load.ts'
import {
  appendHostLoadSample,
  HOST_LOAD_WAIT_MIN_MS,
  type HostLoadSample,
  hostLoadCommand,
  readHostLoadSamplesSince,
  sampleHostLoad,
  summarizeHostLoadWindow,
} from './host-load-series.ts'

const trackResidue = trackedTestResidue()
let state: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  state = trackResidue(join(suiteDir, `host-load-${crypto.randomUUID()}`))
  env = { ...process.env, [STATE_HOME_ENV]: state }
})

const sample = (over: Partial<HostLoadSample> = {}): HostLoadSample => ({
  at: '2026-10-30T17:00:00.000Z',
  cpuBusy: 2,
  swapUsed: 1_000,
  loadavg1: 1.5,
  ...over,
})

const load = (cpuBusy: number | null): HostLoad => ({
  gates: 0,
  loadavg: 1.5,
  cpuBusy,
  ncpu: 4,
  freeMem: 1_000,
  pressure: 'normal',
  swapUsed: 2_000,
  swapTotal: 4_000,
  swapGrowthBytesPerSec: null,
  recentAdmissions: 0,
  waitingRequests: 0,
  oldestWaitMs: 0,
})

const cpu = (user: number, idle: number) => ({
  model: 'fixed',
  speed: 1,
  times: { user, nice: 0, sys: 0, idle, irq: 0 },
})

describe('host load sampler', () => {
  test('two readings append one complete line that round-trips', async () => {
    const readings = [
      [cpu(0, 0), cpu(0, 0)],
      [cpu(100, 0), cpu(50, 50)],
    ]
    let now = 0
    const result = await sampleHostLoad({
      env,
      measure: () => {
        now += 1_000
        return {
          ...measureHostLoad(env, process.pid, 'win32', now, {
            readCpus: () => readings.shift()!,
          }),
          loadavg: 1.5,
          swapUsed: 2_000,
        }
      },
      sleep: async () => {},
      now: () => new Date('2026-10-30T17:00:01.000Z'),
    })

    expect(result).toEqual({
      at: '2026-10-30T17:00:01.000Z',
      cpuBusy: 1.5,
      swapUsed: 2_000,
      loadavg1: 1.5,
    })
    expect(readHostLoadSamplesSince('2026-10-30T17:00:00.000Z', env)).toEqual([result])
    expect(readFileSync(join(state, 'orchestrator', 'host-load.jsonl'), 'utf8')).toBe(
      `${JSON.stringify(result)}\n`,
    )
  })

  test('refuses a second reading without a CPU delta', async () => {
    await expect(
      sampleHostLoad({ env, measure: () => load(null), sleep: async () => {} }),
    ).rejects.toThrow('produced no delta')
  })
})

describe('host load window', () => {
  test('returns nearest-rank quantiles, swap delta, and qualifying wait count', () => {
    const samples = [
      sample({ cpuBusy: 1 }),
      sample({ at: '2026-10-30T17:01:00.000Z', cpuBusy: 4, swapUsed: 1_500 }),
      sample({ at: '2026-10-30T17:02:00.000Z', cpuBusy: 2, swapUsed: 2_000, loadavg1: 3 }),
    ]
    const waits = [
      {
        at: samples[0]!.at,
        resourceKind: 'cpu' as const,
        resourceKey: 'host-capacity',
        durationMs: HOST_LOAD_WAIT_MIN_MS,
      },
      {
        at: samples[0]!.at,
        resourceKind: 'cpu' as const,
        resourceKey: 'host-capacity',
        durationMs: HOST_LOAD_WAIT_MIN_MS - 1,
      },
      {
        at: samples[0]!.at,
        resourceKind: 'lock' as const,
        resourceKey: 'create',
        durationMs: 5_000,
      },
    ]

    expect(summarizeHostLoadWindow(samples, [0.5, 0.95], waits)).toEqual({
      sampleCount: 3,
      firstSampleAt: '2026-10-30T17:00:00.000Z',
      lastSampleAt: '2026-10-30T17:02:00.000Z',
      cpuBusyQuantiles: { '0.5': 2, '0.95': 4 },
      latestSwapUsed: 2_000,
      swapDelta: 1_000,
      latestLoadavg1: 3,
      hostCapacityWaitCount: 1,
    })
  })

  test('an empty sample window is a refusal, never a zero report', async () => {
    expect(summarizeHostLoadWindow([], [0.5], [])).toBeNull()
    await expect(
      hostLoadCommand(
        db(),
        { json: true },
        { env, now: () => Date.parse('2026-10-30T17:30:00.000Z'), write: async () => {} },
      ),
    ).rejects.toThrow('machine load sample')
  })
})

test('bounded host load entries retain their exact fields', () => {
  const value = sample()
  appendHostLoadSample(value, env)
  expect(readHostLoadSamplesSince('2026-10-30T16:59:00.000Z', env)).toEqual([value])
})
