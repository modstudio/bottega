import { expect, test } from 'bun:test'
import type { PressureSample } from './host-pressure-decision.ts'
import { hostPressureReport } from './host-pressure-report.ts'

const sample = (sampledAt: string, loadavg: number, memoryPressure: string): PressureSample => ({
  sampledAt: Date.parse(sampledAt),
  loadavg,
  ncpu: 4,
  memoryPressure,
  processes: null,
  observationElapsedMs: 1,
  observationCpuMs: 1,
})

test('host pressure derives nearest-rank load, pressure shares, and recorded wait kinds', () => {
  const window = { start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z' }
  const report = hostPressureReport(
    [
      sample('2026-10-01T01:00:00Z', 2, 'normal'),
      sample('2026-10-01T02:00:00Z', 4, 'warning'),
      sample('2026-10-01T03:00:00Z', 8, 'warning'),
      sample(window.end, 100, 'critical'),
    ],
    [
      {
        at: '2026-10-01T01:00:00Z',
        resourceKind: 'cpu',
        resourceKey: 'host-capacity',
        durationMs: 10,
      },
      {
        at: '2026-10-01T02:00:00Z',
        resourceKind: 'cpu',
        resourceKey: 'host-capacity',
        durationMs: 30,
      },
      {
        at: '2026-10-01T03:00:00Z',
        resourceKind: 'lock',
        resourceKey: 'create',
        durationMs: 7,
      },
    ],
    window,
  )
  expect(report.sampleCount).toBe(3)
  expect(report.loadAveragePerCpu).toEqual({ median: 1, p90: 2 })
  expect(report.pressureLevels).toEqual([
    { level: 'normal', count: 1, share: 1 / 3 },
    { level: 'warning', count: 2, share: 2 / 3 },
  ])
  expect(report.contentions).toEqual([
    { kind: 'host-capacity (runs and gates)', waits: 2, medianWaitMs: 10, totalWaitMs: 40 },
    { kind: 'lock/create', waits: 1, medianWaitMs: 7, totalWaitMs: 7 },
  ])
})
