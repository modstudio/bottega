// concern: host-pressure efficiency report
/** Derives windowed host pressure and wait cost from recorded plain observations. */

import type { Database } from 'bun:sqlite'
import {
  type ContentionWait,
  isHostCapacityWait,
  loadContentionWaits,
} from '../database/contention.ts'
import { nearestRankPercentile } from '../state/statistics.ts'
import type { PressureSample } from './host-pressure-decision.ts'
import { loadHostPressureSamples } from './host-pressure-service.ts'

export type HostPressureWindow = { start: string; end: string }

export type HostPressureContention = ContentionWait

const inWindow = (at: number, window: HostPressureWindow) =>
  at >= Date.parse(window.start) && at < Date.parse(window.end)

const contentionLabel = (row: HostPressureContention) =>
  isHostCapacityWait(row)
    ? 'host-capacity (runs and gates)'
    : `${row.resourceKind}/${row.resourceKey}`

export function hostPressureReport(
  samples: readonly PressureSample[],
  contentions: readonly HostPressureContention[],
  window: HostPressureWindow,
) {
  const windowSamples = samples.filter((sample) => inWindow(sample.sampledAt, window))
  const loadPerCpu = windowSamples.map((sample) => sample.loadavg / sample.ncpu)
  const pressureLevels = new Map<string, number>()
  for (const sample of windowSamples)
    pressureLevels.set(sample.memoryPressure, (pressureLevels.get(sample.memoryPressure) ?? 0) + 1)
  const grouped = new Map<string, HostPressureContention[]>()
  for (const row of contentions.filter((row) => inWindow(Date.parse(row.at), window))) {
    const label = contentionLabel(row)
    grouped.set(label, [...(grouped.get(label) ?? []), row])
  }
  return {
    window,
    sampleCount: windowSamples.length,
    sampleSpan: windowSamples.length
      ? {
          start: new Date(
            Math.min(...windowSamples.map((sample) => sample.sampledAt)),
          ).toISOString(),
          end: new Date(Math.max(...windowSamples.map((sample) => sample.sampledAt))).toISOString(),
        }
      : null,
    loadAveragePerCpu: {
      median: nearestRankPercentile(loadPerCpu, 0.5),
      p90: nearestRankPercentile(loadPerCpu, 0.9),
    },
    pressureLevels: [...pressureLevels]
      .map(([level, count]) => ({ level, count, share: count / windowSamples.length }))
      .sort((left, right) => left.level.localeCompare(right.level)),
    contentions: [...grouped]
      .map(([kind, rows]) => {
        const durations = rows.flatMap((row) =>
          row.durationMs === null ? [] : [Math.max(0, row.durationMs)],
        )
        return {
          kind,
          waits: rows.length,
          medianWaitMs: nearestRankPercentile(durations, 0.5),
          totalWaitMs: durations.reduce((sum, duration) => sum + duration, 0),
        }
      })
      .sort((left, right) => left.kind.localeCompare(right.kind)),
  }
}

export function loadHostPressureReport(
  database: Database,
  windows: { currentWindow: HostPressureWindow; previousWindow: HostPressureWindow },
) {
  const samples = loadHostPressureSamples(database, Date.parse(windows.currentWindow.end))
  const rows = loadContentionWaits(
    database,
    windows.previousWindow.start,
    windows.currentWindow.end,
  )
  return {
    current: hostPressureReport(samples, rows, windows.currentWindow),
    previous: hostPressureReport(samples, rows, windows.previousWindow),
  }
}
