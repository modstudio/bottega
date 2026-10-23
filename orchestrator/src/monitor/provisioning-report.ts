// concern: provisioning report
/** Provisioning history query and pure aggregation. */
import type { Database } from 'bun:sqlite'
import { nearestRankPercentile } from '../state/statistics.ts'
import type { MonitorHostLoad } from './monitor-types.ts'
import { type ReportFilterOptions, reportFilter } from './report-filter.ts'

export type ProvisioningObservation = {
  project: string
  kind: 'writer' | 'read-only'
  outcome: 'ok' | 'failed'
  durationMs: number
  entries: number | null
  entriesLimited: boolean | null
  hostLoad: MonitorHostLoad
}

const PROVISIONING_COMPARABLE_MIN_RUNS = 5

const range = (values: number[]) => ({ min: Math.min(...values), max: Math.max(...values) })

export function provisioningReport(rows: readonly ProvisioningObservation[]) {
  const groups = new Map<string, ProvisioningObservation[]>()
  for (const row of rows) {
    const key = `${row.project}\0${row.kind}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.values()]
    .map((group) => {
      const first = group[0]!
      const exactEntries = group.flatMap((row) =>
        row.entries !== null && row.entriesLimited === false ? [row.entries] : [],
      )
      return {
        project: first.project,
        kind: first.kind,
        runs: group.length,
        outcomes: {
          ok: group.filter((row) => row.outcome === 'ok').length,
          failed: group.filter((row) => row.outcome === 'failed').length,
        },
        provisioningMs: {
          median: nearestRankPercentile(
            group.map((row) => row.durationMs),
            0.5,
          ),
          p90: nearestRankPercentile(
            group.map((row) => row.durationMs),
            0.9,
          ),
        },
        entries: {
          median: nearestRankPercentile(exactEntries, 0.5),
          p90: nearestRankPercentile(exactEntries, 0.9),
          limitedRuns: group.filter((row) => row.entriesLimited === true).length,
          unavailableRuns: group.filter((row) => row.entries === null).length,
        },
        hostLoad: {
          oneMinute: range(group.map((row) => row.hostLoad.loadavg)),
          cpuCount: range(group.map((row) => row.hostLoad.ncpu)),
          freeMemory: range(group.map((row) => row.hostLoad.freeMem)),
          liveRuns: range(group.map((row) => row.hostLoad.liveRuns)),
          swapUsed: range(group.map((row) => row.hostLoad.swapUsed)),
          swapTotal: range(group.map((row) => row.hostLoad.swapTotal)),
          pressure: [...new Set(group.map((row) => row.hostLoad.pressure))],
        },
        comparison:
          group.length < PROVISIONING_COMPARABLE_MIN_RUNS
            ? `sample too small to compare (${group.length}/${PROVISIONING_COMPARABLE_MIN_RUNS} runs)`
            : 'comparable',
      }
    })
    .sort((a, b) => a.project.localeCompare(b.project) || a.kind.localeCompare(b.kind))
}

export function loadProvisioningReport(database: Database, options: ReportFilterOptions) {
  const filter = reportFilter(options)
  const rows = database
    .query(
      `SELECT project.name project,r.provisioning_kind kind,r.provisioning_outcome outcome,
      r.provisioning_ms duration_ms,r.provisioning_entries entries,
      r.provisioning_entries_limited entries_limited,r.provisioning_host_load host_load
      FROM run r JOIN project ON project.record_id=r.project_record_id
      WHERE r.provisioning_ms IS NOT NULL AND (? IS NULL OR project.name=?)
      AND (? IS NULL OR r.started_at>=?) AND (? IS NULL OR r.started_at<?)`,
    )
    .all(...filter.parameters) as {
    project: string
    kind: 'writer' | 'read-only'
    outcome: 'ok' | 'failed'
    duration_ms: number
    entries: number | null
    entries_limited: number | null
    host_load: string
  }[]
  return provisioningReport(
    rows.map((row) => ({
      project: row.project,
      kind: row.kind,
      outcome: row.outcome,
      durationMs: row.duration_ms,
      entries: row.entries,
      entriesLimited: row.entries_limited === null ? null : Boolean(row.entries_limited),
      hostLoad: JSON.parse(row.host_load) as MonitorHostLoad,
    })),
  )
}
