import { expect, test } from 'bun:test'
import type { MonitorHostLoad } from './monitor-types.ts'
import { formatHostLoadLine } from './monitor-commands.ts'

const hostLoad: MonitorHostLoad = {
  gates: 0,
  loadavg: 15.75,
  ncpu: 16,
  freeMem: 1,
  pressure: 'normal',
  swapUsed: 0,
  swapTotal: 0,
  recentAdmissions: 0,
  waitingRequests: 0,
  oldestWaitMs: 0,
  liveRuns: 20,
}

test('the host line reports the run queue beside gate broker waiters', () => {
  expect(
    formatHostLoadLine(hostLoad, { waiting: 11, oldestWaitMs: 540_000, heldOn: ['load'] }),
  ).toContain(
    '0 broker request(s) waiting, oldest 0ms; 11 run(s) waiting for host capacity, oldest 540000ms, held on load',
  )
})

test('the host line names how many waiters sit behind the head', () => {
  expect(
    formatHostLoadLine(hostLoad, { waiting: 3, oldestWaitMs: 1_000, heldOn: ['load', 'memory'] }),
  ).toContain(
    '3 run(s) waiting for host capacity, oldest 1000ms, held on load+memory; 2 queued behind',
  )
})
