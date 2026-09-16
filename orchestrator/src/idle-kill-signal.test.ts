// Decisions of terminateProcessGroup's signalling path, beside idle-kill.ts; the file that owns the idle decisions is frozen.
import { expect, test } from 'bun:test'
import { isGroupKillablePgid, terminateProcessGroup } from './idle-kill.ts'

test('group kill is only allowed for a known pgid that is not the caller', () => {
  expect(isGroupKillablePgid(50, 1)).toBe(true)
  expect(isGroupKillablePgid(50, 50)).toBe(false)
  expect(isGroupKillablePgid(50, null)).toBe(false)
  expect(isGroupKillablePgid(1, 2)).toBe(false)
  expect(isGroupKillablePgid(0, 2)).toBe(false)
  expect(isGroupKillablePgid(null, 2)).toBe(false)
  expect(isGroupKillablePgid(undefined, 2)).toBe(false)
})

test('a group signal refused with EPERM falls through to the sampled descendants', async () => {
  const signals: Array<{ pid: number; signal: NodeJS.Signals | number }> = []
  const result = await terminateProcessGroup(100, {
    graceMs: 5,
    killConfirmMs: 5,
    deps: {
      kill(pid, signal) {
        if (pid < 0) {
          const e = new Error('kill() failed: EPERM') as NodeJS.ErrnoException
          e.code = 'EPERM'
          throw e
        }
        signals.push({ pid, signal })
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
