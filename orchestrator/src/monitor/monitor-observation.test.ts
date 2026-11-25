import { expect, test } from 'bun:test'
import { appendMonitorObservation } from './monitor-observation.ts'
import { finishMonitorResult } from './monitor-result.ts'
import type { MonitorCondition, MonitorHostLoad } from './monitor-types.ts'

const hostLoad: MonitorHostLoad = {
  gates: 0,
  loadavg: 0,
  cpuBusy: null,
  ncpu: 1,
  freeMem: 1,
  pressure: 'normal',
  swapUsed: 0,
  swapTotal: 0,
  swapGrowthBytesPerSec: null,
  recentAdmissions: 0,
  waitingRequests: 0,
  oldestWaitMs: 0,
  liveRuns: 0,
}

test('a folded not-applicable reason survives in the finished monitor result', () => {
  const conditions: MonitorCondition[] = []
  const errors: string[] = []
  const notApplicable: string[] = []
  const reason = 'retrieval benchmark pin observation not applicable: fixture reason'

  appendMonitorObservation(conditions, errors, notApplicable, {
    conditions: [],
    errors: [],
    notApplicable: [reason],
  })
  const result = finishMonitorResult(
    1,
    '2026-11-25T00:00:00.000Z',
    '2026-11-25T00:00:01.000Z',
    'invoked',
    conditions,
    errors,
    notApplicable,
    { findings: 0, docs: 0 },
    hostLoad,
    {
      available: false,
      error: null,
      memoryPressure: null,
      attributions: [],
      averageObservationElapsedMs: null,
      averageObservationCpuMs: null,
    },
  )

  expect(result.notApplicable).toEqual([reason])
})
