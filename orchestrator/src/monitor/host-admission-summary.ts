// concern: host admission monitor summary
/** Summarizes persisted admission decisions; the adapter only gathers run rows. */

import type { Database } from 'bun:sqlite'
import type { MemoryPressure } from '../gate-load.ts'
import type { RunHostAdmission } from '../run/run-host-capacity.ts'

export const HOST_ADMISSION_MONITOR_WINDOW_MS = 60 * 60_000

export type HostAdmissionSummary = {
  windowMs: number
  admitted: number
  held: number
  highestLoadavg: number | null
  highestCpuBusy: number | null
  pressures: MemoryPressure[]
}

type AdmissionPair = {
  first: RunHostAdmission
  admitted: RunHostAdmission
}

export function summarizeHostAdmissions(
  admissions: AdmissionPair[],
  clock: number,
  windowMs = HOST_ADMISSION_MONITOR_WINDOW_MS,
): HostAdmissionSummary {
  const recent = admissions.filter(({ admitted }) => {
    const at = Date.parse(admitted.at)
    return Number.isFinite(at) && clock - at >= 0 && clock - at <= windowMs
  })
  const cpuBusy = recent.flatMap(({ admitted }) =>
    admitted.sample.cpuBusy === null ? [] : [admitted.sample.cpuBusy],
  )
  return {
    windowMs,
    admitted: recent.length,
    held: recent.filter(({ first }) => first.decision === 'hold').length,
    highestLoadavg: recent.length
      ? Math.max(...recent.map(({ admitted }) => admitted.sample.loadavg))
      : null,
    highestCpuBusy: cpuBusy.length ? Math.max(...cpuBusy) : null,
    pressures: [...new Set(recent.map(({ admitted }) => admitted.sample.pressure))],
  }
}

export function hostAdmissionSummary(database: Database, clock: number): HostAdmissionSummary {
  const windowStart = new Date(clock - HOST_ADMISSION_MONITOR_WINDOW_MS).toISOString()
  const windowEnd = new Date(clock).toISOString()
  const rows = database
    .query(
      `SELECT host_admission_first,host_admission FROM run
        WHERE host_admission_first IS NOT NULL AND host_admission IS NOT NULL
          AND json_extract(host_admission,'$.at') BETWEEN ? AND ?`,
    )
    .all(windowStart, windowEnd) as { host_admission_first: string; host_admission: string }[]
  return summarizeHostAdmissions(
    rows.map((row) => ({
      first: JSON.parse(row.host_admission_first) as RunHostAdmission,
      admitted: JSON.parse(row.host_admission) as RunHostAdmission,
    })),
    clock,
  )
}
