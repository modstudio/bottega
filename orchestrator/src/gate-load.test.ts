import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_HOME_ENV } from '../../shared/state-directory.ts'
import { dir as suiteDir } from '../test/fixtures/store.ts'
import { trackedTestResidue } from '../test/residue.ts'
import type { HostLoad } from './gate-load.ts'
import {
  decideHostCapacityAdmission,
  decideHostSlotAdmission,
  HOST_SLOT_HELD_ENV,
  measureHostSlotLeases,
  measureHostWaiters,
  parseMacOSMemoryPressure,
  parseSwapUsage,
  withGateSlot,
} from './gate-load.ts'

const trackResidue = trackedTestResidue()
beforeEach(() => {
  trackResidue(join(suiteDir, 'gates'))
})

const stateEnvironment = (name: string) => {
  const state = trackResidue(join(suiteDir, name))
  return {
    state,
    env: {
      ...process.env,
      CI: undefined,
      [HOST_SLOT_HELD_ENV]: undefined,
      [STATE_HOME_ENV]: state,
    },
    slots: join(state, 'orchestrator', 'host-slots'),
  }
}

test('swap parsing supports macOS and Linux samples', () => {
  expect(parseSwapUsage('total = 4096.00M  used = 1024.50M  free = 3071.50M')).toEqual({
    total: 4_294_967_296,
    used: 1_074_266_112,
  })
  expect(parseSwapUsage('SwapTotal:       2048 kB\nSwapFree:         512 kB')).toEqual({
    total: 2_097_152,
    used: 1_572_864,
  })
})

const idle = (over: Partial<HostLoad> = {}): HostLoad => ({
  gates: 1,
  loadavg: 0.2,
  ncpu: 8,
  freeMem: 8 * 1024 * 1024 * 1024,
  pressure: 'unknown',
  swapUsed: 0,
  swapTotal: 0,
  recentAdmissions: 0,
  waitingRequests: 0,
  oldestWaitMs: 0,
  ...over,
})

const decision = (load: HostLoad, platform: NodeJS.Platform = 'linux') =>
  decideHostSlotAdmission({
    heldSlots: load.gates,
    loadavg: load.loadavg,
    ncpu: load.ncpu,
    recentAdmissions: load.recentAdmissions,
    freeMem: load.freeMem,
    pressure: load.pressure,
    platform,
  })

describe('gate load hold', () => {
  test('shared capacity decision holds on load and memory, admits solo work, and releases at the bound', () => {
    const base = {
      heldWork: 1,
      loadavg: 8,
      ncpu: 8,
      recentAdmissions: 0,
      freeMem: 512 * 1024 * 1024,
      pressure: 'unknown' as const,
      limit: null,
      platform: 'linux' as const,
    }
    expect(decideHostCapacityAdmission(base)).toEqual({
      admit: false,
      heldOn: ['load', 'memory'],
      boundReached: false,
    })
    expect(decideHostCapacityAdmission({ ...base, heldWork: 0 })).toEqual({
      admit: true,
      heldOn: [],
      boundReached: false,
    })
    expect(
      decideHostCapacityAdmission({ ...base, waitedMs: 15 * 60_000, maxWaitMs: 15 * 60_000 }),
    ).toEqual({ admit: true, heldOn: [], boundReached: true })
  })

  test('shared capacity decision preserves waiter arrival order', () => {
    const input = {
      heldWork: 0,
      loadavg: 16,
      ncpu: 8,
      recentAdmissions: 0,
      freeMem: 8 * 1024 * 1024 * 1024,
      pressure: 'unknown' as const,
      limit: null,
      platform: 'linux' as const,
    }
    expect(decideHostCapacityAdmission({ ...input, hasOlderWaiter: true })).toEqual({
      admit: false,
      heldOn: ['queue'],
      boundReached: false,
    })
    expect(decideHostCapacityAdmission({ ...input, hasOlderWaiter: false }).admit).toBe(true)
  })

  test('CPU and memory floors hold even with one gate', () => {
    expect(decision(idle({ gates: 1, loadavg: 8, ncpu: 8 })).heldOn).toEqual(['load'])
    expect(decision(idle({ gates: 1, freeMem: 512 * 1024 * 1024 })).heldOn).toEqual(['memory'])
    expect(decision(idle({ gates: 1 })).heldOn).toEqual([])
    expect(decision(idle({ gates: 2 })).heldOn).toEqual(['gates'])
  })

  test('admission decision names each threshold alone and in combination', () => {
    expect(decision(idle({ gates: 2 })).heldOn).toEqual(['gates'])
    expect(decision(idle({ loadavg: 8, ncpu: 8 })).heldOn).toEqual(['load'])
    expect(decision(idle({ freeMem: 64 * 1024 * 1024 })).heldOn).toEqual(['memory'])
    expect(
      decision(idle({ gates: 3, loadavg: 8, ncpu: 8, freeMem: 64 * 1024 * 1024 })).heldOn,
    ).toEqual(['gates', 'load', 'memory'])
    expect(decision(idle()).heldOn).toEqual([])
  })

  test('admits one project step under unrelated high load and memory pressure', () => {
    const result = decision(idle({ gates: 0, loadavg: 32, ncpu: 8, freeMem: 64 * 1024 * 1024 }))
    expect(result).toEqual({ admit: true, heldOn: [] })
  })

  test('holds on load only while a project slot is already held', () => {
    expect(decision(idle({ gates: 0, loadavg: 8, ncpu: 8 })).admit).toBe(true)
    expect(decision(idle({ gates: 1, loadavg: 8, ncpu: 8 }))).toEqual({
      admit: false,
      heldOn: ['load'],
    })
  })

  test('recent admissions reserve load capacity without changing the gate count decision', () => {
    expect(decision(idle({ gates: 1, loadavg: 6.5, ncpu: 8, recentAdmissions: 2 })).heldOn).toEqual(
      ['load'],
    )
    expect(decision(idle({ gates: 1, loadavg: 0.2, ncpu: 8, recentAdmissions: 2 })).heldOn).toEqual(
      [],
    )
  })

  test('macOS memory holds only on warning or critical pressure', () => {
    const lowFreeMem = 64 * 1024 * 1024
    expect(decision(idle({ freeMem: lowFreeMem, pressure: 'warning' }), 'darwin').heldOn).toEqual([
      'memory',
    ])
    expect(decision(idle({ freeMem: lowFreeMem, pressure: 'critical' }), 'darwin').heldOn).toEqual([
      'memory',
    ])
    expect(decision(idle({ freeMem: lowFreeMem, pressure: 'normal' }), 'darwin').heldOn).toEqual([])
    expect(decision(idle({ freeMem: lowFreeMem, pressure: 'unknown' }), 'darwin').heldOn).toEqual(
      [],
    )
  })

  test('other platforms use free memory regardless of pressure', () => {
    for (const pressure of ['normal', 'warning', 'critical', 'unknown'] as const) {
      expect(decision(idle({ freeMem: 64 * 1024 * 1024, pressure })).heldOn).toEqual(['memory'])
      expect(decision(idle({ freeMem: 8 * 1024 * 1024 * 1024, pressure })).heldOn).toEqual([])
    }
  })

  test('withGateSlot holds then runs', async () => {
    let n = 0
    const sleeps: number[] = []
    const lines: string[] = []
    const error = spyOn(console, 'error').mockImplementation((line) => lines.push(String(line)))
    let result = ''
    try {
      result = await withGateSlot(async () => 'ok', {
        platform: 'linux',
        env: { ...process.env, CI: undefined, [HOST_SLOT_HELD_ENV]: undefined },
        // The measure reports OTHER runners; withGateSlot adds this one.
        measure: () => {
          n++
          return n === 1 ? idle({ gates: 2 }) : idle({ gates: 1 })
        },
        sleep: async (ms) => {
          sleeps.push(ms)
        },
        pollMs: 25,
      })
    } finally {
      error.mockRestore()
    }
    expect(result).toBe('ok')
    expect(sleeps.length).toBeGreaterThan(0)
    expect(n).toBe(2)
    expect(lines[0]).toContain('held_on=gates')
  })

  test('withGateSlot reports every condition seen while the hold changes', async () => {
    let clock = 0
    const lines: string[] = []
    const error = spyOn(console, 'error').mockImplementation((line) => lines.push(String(line)))
    try {
      await withGateSlot(async () => 'ok', {
        env: { ...process.env, CI: undefined, [HOST_SLOT_HELD_ENV]: undefined },
        measure: () => {
          if (clock === 0) return idle({ gates: 2 })
          if (clock === 25) return idle({ gates: 1, freeMem: 64 * 1024 * 1024 })
          return idle({ gates: 1 })
        },
        sleep: async (ms) => {
          clock += ms
        },
        now: () => clock,
        pollMs: 25,
        platform: 'linux',
      })
    } finally {
      error.mockRestore()
    }
    expect(lines[0]).toContain('held_on=gates+memory')
  })

  test('withGateSlot reports its completed capacity wait', async () => {
    let clock = 0
    const lines: string[] = []
    const error = spyOn(console, 'error').mockImplementation((line) => {
      lines.push(String(line))
    })
    try {
      const result = await withGateSlot(async () => 'ok', {
        env: { ...process.env, CI: undefined, [HOST_SLOT_HELD_ENV]: undefined },
        measure: () =>
          clock < 50 ? idle({ gates: 1, freeMem: 64 * 1024 * 1024 }) : idle({ gates: 1 }),
        sleep: async (ms) => {
          clock += ms
        },
        now: () => clock,
        pollMs: 25,
        platform: 'linux',
      })
      expect(result).toBe('ok')
    } finally {
      error.mockRestore()
    }
    expect(lines[0]).toStartWith('waiting 50ms for host capacity ')
    expect(lines[0]).toContain('gates=1 loadavg=0.2 ncpu=8')
    expect(lines[0]).toContain('free_mb=64 floor_mb=1024')
    expect(lines[0]).toContain('floor_mb=1024 pressure=unknown held_on=memory')
    expect(lines[0]).toContain('held_on=memory')
    expect(lines).toHaveLength(1)
  })

  test('withGateSlot does not hold for host load under CI', async () => {
    const result = await withGateSlot(async () => 'ok', {
      platform: 'linux',
      env: { ...process.env, CI: '1' },
      measure: () => idle({ gates: 3, loadavg: 8, ncpu: 8 }),
      sleep: async () => {
        throw new Error('must not sleep under CI')
      },
    })
    expect(result).toBe('ok')
  })

  test('an inherited broker slot bypasses the nested gate acquisition', async () => {
    const result = await withGateSlot(async () => 'ok', {
      env: { ...process.env, [HOST_SLOT_HELD_ENV]: '1' },
      measure: () => {
        throw new Error('a nested gate must not measure or acquire another slot')
      },
    })
    expect(result).toBe('ok')
  })

  test('a cancelled waiter is visible and never enters the run callback', async () => {
    const controller = new AbortController()
    const { env } = stateEnvironment('cancelled-wait-state')
    let ran = false
    let visibleWaiters = 0
    let finishedWaits = 0
    await expect(
      withGateSlot(
        async () => {
          ran = true
        },
        {
          env,
          platform: 'linux',
          signal: controller.signal,
          measure: () => idle({ gates: 2 }),
          onWait: () => {
            visibleWaiters = measureHostWaiters(env).waitingRequests
            controller.abort()
          },
          onWaitFinished: () => {
            finishedWaits += 1
          },
        },
      ),
    ).rejects.toThrow('host slot wait was cancelled')
    expect(ran).toBe(false)
    expect(visibleWaiters).toBe(1)
    expect(finishedWaits).toBe(1)
    expect(measureHostWaiters(env).waitingRequests).toBe(0)
  })

  test.each([
    ['empty', ''],
    ['zero PID', '0'],
  ])('reclaims the %s acquisition lock', async (_label, contents) => {
    const { env, slots: gateDir } = stateEnvironment(`stale-lock-${contents || 'empty'}`)
    mkdirSync(gateDir, { recursive: true })
    writeFileSync(join(gateDir, 'acquire.lock'), contents)
    let sleeps = 0
    await withGateSlot(async () => {}, {
      env,
      measure: () => idle({ gates: 0 }),
      sleep: async () => {
        sleeps += 1
      },
      platform: 'linux',
    })
    expect(sleeps).toBe(1)
  })

  test('slot inspection leaves symlinks and directories untouched while reaping invalid and dead leases', () => {
    const { env, state, slots } = stateEnvironment('unsafe-slot-entries')
    mkdirSync(slots, { recursive: true })
    const target = join(state, 'target')
    writeFileSync(target, 'must survive')
    const symlinkLease = join(slots, '1-00000000-0000-4000-8000-000000000001')
    const directoryLease = join(slots, '1-00000000-0000-4000-8000-000000000002')
    const invalidLease = join(slots, '1-00000000-0000-4000-8000-000000000003')
    const deadLease = join(slots, '1-00000000-0000-4000-8000-000000000004')
    symlinkSync(target, symlinkLease)
    mkdirSync(directoryLease)
    writeFileSync(invalidLease, 'not json')
    writeFileSync(deadLease, JSON.stringify({ pid: 2_147_483_647, admittedAt: 0 }))

    expect(measureHostSlotLeases(env)).toBe(0)
    expect(lstatSync(symlinkLease).isSymbolicLink()).toBe(true)
    expect(lstatSync(directoryLease).isDirectory()).toBe(true)
    expect(existsSync(target)).toBe(true)
    expect(existsSync(invalidLease)).toBe(false)
    expect(existsSync(deadLease)).toBe(false)
  })
})

describe('macOS memory pressure parsing', () => {
  test.each([
    ['1', 'normal'],
    [' 2\n', 'warning'],
    ['\t4 ', 'critical'],
    ['', 'unknown'],
    ['3', 'unknown'],
    ['warning', 'unknown'],
    [undefined, 'unknown'],
  ] as const)('maps %p to %s', (output, expected) => {
    expect(parseMacOSMemoryPressure(output)).toBe(expected)
  })
})

describe('gate slots under concurrency', () => {})
