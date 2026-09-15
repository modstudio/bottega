// Decisions of terminateProcessGroup's signalling path, beside idle-kill.ts; the file that owns the idle decisions is frozen.
import { expect, test } from 'bun:test'
import { terminateProcessGroup } from './idle-kill.ts'

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
