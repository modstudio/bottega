import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { dir as suiteDir } from '../test/fixtures/store.ts'
import { trackedTestResidue } from '../test/residue.ts'
import type { HostLoad } from './gate-load.ts'
import {
  GATE_CONCURRENCY_LIMIT,
  gateHoldConditions,
  holdForGateCapacity,
  parseMacOSMemoryPressure,
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
  pressure: 'unknown',
  ...over,
})

describe('gate load hold', () => {
  test('persistent overload waits the full maximum and reports exhaustion', async () => {
    let clock = 0
    const result = await holdForGateCapacity({
      measure: () => idle({ gates: 3 }),
      sleep: async (ms) => {
        clock += ms
      },
      now: () => clock,
      pollMs: 25,
      maxMs: 100,
    })
    expect(result).toEqual({
      delayedMs: 100,
      held: true,
      exhausted: true,
      load: idle({ gates: 3 }),
      heldOn: ['gates'],
    })
  })

  test('capacity freeing mid-hold reports the elapsed wait without exhaustion', async () => {
    let clock = 0
    const result = await holdForGateCapacity({
      measure: () => (clock < 50 ? idle({ gates: 3 }) : idle({ gates: 1 })),
      sleep: async (ms) => {
        clock += ms
      },
      now: () => clock,
      pollMs: 25,
      maxMs: 100,
    })
    expect(result).toEqual({
      delayedMs: 50,
      held: true,
      exhausted: false,
      load: idle({ gates: 1 }),
      heldOn: ['gates'],
    })
  })

  test('two concurrent gates need no hold and report no exhaustion', async () => {
    const result = await holdForGateCapacity({
      measure: () => idle({ gates: GATE_CONCURRENCY_LIMIT }),
      sleep: async () => {
        throw new Error('must not sleep under the limit')
      },
    })
    expect(result).toEqual({
      delayedMs: 0,
      held: false,
      exhausted: false,
      load: idle({ gates: GATE_CONCURRENCY_LIMIT }),
      heldOn: [],
    })
  })

  test('elapsed clock time, rather than poll count, ends the hold', async () => {
    let clock = 0
    const sleeps: number[] = []
    const result = await holdForGateCapacity({
      measure: () => idle({ gates: 3 }),
      sleep: async (ms) => {
        sleeps.push(ms)
        clock += ms + 15
      },
      now: () => clock,
      pollMs: 25,
      maxMs: 100,
    })
    expect(sleeps).toEqual([25, 25, 20])
    expect(result.delayedMs).toBe(115)
    expect(result.exhausted).toBe(true)
    expect(result.heldOn).toEqual(['gates'])
  })

  test('CPU and memory floors hold even with one gate', () => {
    expect(shouldHoldShard(idle({ gates: 1, loadavg: 8, ncpu: 8 }))).toBe(true)
    expect(
      gateHoldConditions(idle({ gates: 1, freeMem: 512 * 1024 * 1024 }), undefined, 'linux'),
    ).toEqual(['memory'])
    expect(shouldHoldShard(idle({ gates: 2 }))).toBe(false)
    expect(shouldHoldShard(idle({ gates: 3 }))).toBe(true)
  })

  test('hold conditions name each threshold alone and in combination', () => {
    expect(gateHoldConditions(idle({ gates: 3 }), undefined, 'linux')).toEqual(['gates'])
    expect(gateHoldConditions(idle({ loadavg: 8, ncpu: 8 }), undefined, 'linux')).toEqual(['load'])
    expect(gateHoldConditions(idle({ freeMem: 64 * 1024 * 1024 }), undefined, 'linux')).toEqual([
      'memory',
    ])
    expect(
      gateHoldConditions(
        idle({ gates: 3, loadavg: 8, ncpu: 8, freeMem: 64 * 1024 * 1024 }),
        undefined,
        'linux',
      ),
    ).toEqual(['gates', 'load', 'memory'])
    expect(gateHoldConditions(idle(), undefined, 'linux')).toEqual([])
  })

  test('macOS memory holds only on warning or critical pressure', () => {
    const lowFreeMem = 64 * 1024 * 1024
    expect(
      gateHoldConditions(idle({ freeMem: lowFreeMem, pressure: 'warning' }), undefined, 'darwin'),
    ).toEqual(['memory'])
    expect(
      gateHoldConditions(idle({ freeMem: lowFreeMem, pressure: 'critical' }), undefined, 'darwin'),
    ).toEqual(['memory'])
    expect(
      gateHoldConditions(idle({ freeMem: lowFreeMem, pressure: 'normal' }), undefined, 'darwin'),
    ).toEqual([])
    expect(
      gateHoldConditions(idle({ freeMem: lowFreeMem, pressure: 'unknown' }), undefined, 'darwin'),
    ).toEqual([])
  })

  test('other platforms use free memory regardless of pressure', () => {
    for (const pressure of ['normal', 'warning', 'critical', 'unknown'] as const) {
      expect(
        gateHoldConditions(idle({ freeMem: 64 * 1024 * 1024, pressure }), undefined, 'linux'),
      ).toEqual(['memory'])
      expect(
        gateHoldConditions(idle({ freeMem: 8 * 1024 * 1024 * 1024, pressure }), undefined, 'linux'),
      ).toEqual([])
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
        env: { ...process.env, CI: undefined },
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
        maxMs: 100,
        platform: 'linux',
      })
    } finally {
      error.mockRestore()
    }
    expect(lines[0]).toContain('held_on=gates+memory')
  })

  test('withGateSlot preserves the held line and warns after exhaustion', async () => {
    let clock = 0
    const lines: string[] = []
    const error = spyOn(console, 'error').mockImplementation((line) => {
      lines.push(String(line))
    })
    try {
      const result = await withGateSlot(async () => 'ok', {
        env: { ...process.env, CI: undefined },
        measure: () => idle({ gates: 1, freeMem: 64 * 1024 * 1024 }),
        sleep: async (ms) => {
          clock += ms
        },
        now: () => clock,
        pollMs: 25,
        maxMs: 50,
        platform: 'linux',
      })
      expect(result).toBe('ok')
    } finally {
      error.mockRestore()
    }
    expect(lines[0]).toStartWith('held 50ms for host load ')
    expect(lines[0]).toContain('gates=2 loadavg=0.2 ncpu=8')
    expect(lines[0]).toContain('free_mb=64 floor_mb=1024')
    expect(lines[0]).toContain('floor_mb=1024 pressure=unknown held_on=memory')
    expect(lines[0]).toContain('held_on=memory')
    expect(lines[1]).toBe(
      'admitted over the load threshold after the maximum hold; a per-test timeout in this run is suspect, rerun before treating it as a failure',
    )
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
