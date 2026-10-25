// Decisions of terminateProcessGroup's signaling path, beside idle-kill.ts; the file that owns the idle decisions is frozen.
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { isGroupKillablePgid, runHasLiveDescendants, terminateProcessGroup } from './idle-kill.ts'

afterEach(() => mock.restore())

test('group kill is only allowed for a known pgid that is not the caller', () => {
  expect(isGroupKillablePgid(50, 1)).toBe(true)
  expect(isGroupKillablePgid(50, 50)).toBe(false)
  expect(isGroupKillablePgid(50, null)).toBe(false)
  expect(isGroupKillablePgid(1, 2)).toBe(false)
  expect(isGroupKillablePgid(0, 2)).toBe(false)
  expect(isGroupKillablePgid(null, 2)).toBe(false)
  expect(isGroupKillablePgid(undefined, 2)).toBe(false)
})

test('a recorded root known alive remains live when the process snapshot is empty', () => {
  expect(
    runHasLiveDescendants([100], [], {
      sample: () => [],
      alive: (pid) => pid === 100,
    }),
  ).toBe(true)
})

test('a denied group signal falls through to the sampled descendants', async () => {
  const signals: Array<{ pid: number; signal: NodeJS.Signals | number }> = []
  const result = await terminateProcessGroup(100, {
    graceMs: 5,
    killConfirmMs: 5,
    deps: {
      kill(pid, signal) {
        if (pid < 0) return 'denied'
        signals.push({ pid, signal })
        return 'delivered'
      },
      alive: () => false,
      sample: () => [
        { pid: 100, ppid: 1, pgid: 50, cpu: 0, state: 'Z' },
        { pid: 101, ppid: 100, pgid: 50, cpu: 0, state: 'S' },
      ],
      selfPgid: () => 1,
      wait: async () => {},
    },
  })
  expect(signals.some((row) => row.pid === 101 && row.signal === 'SIGTERM')).toBe(true)
  expect(signals.some((row) => row.pid < 0)).toBe(false)
  expect(result.exited).toBe(true)
})

test('a denied direct signal leaves the survivor reported as unkillable', async () => {
  const kill = spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
  })
  const result = await terminateProcessGroup(100, {
    graceMs: 0,
    killConfirmMs: 0,
    deps: {
      alive: () => true,
      sample: () => [{ pid: 100, ppid: 1, pgid: 100, cpu: 0, state: 'S' }],
      selfPgid: () => 100,
      wait: async () => {},
    },
  })

  expect(kill).toHaveBeenCalled()
  expect(result.unkillable).toBe(true)
  expect(result.pids).toContain(100)
})
