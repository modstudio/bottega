// concern: run resource report
/** Run process-resource history query and pure aggregation. */
import type { Database } from 'bun:sqlite'
import { nearestRankPercentile } from '../state/statistics.ts'
import { type ReportFilterOptions, reportFilter } from './report-filter.ts'

export type RunResourceObservation = {
  project: string
  job: string
  agent: string
  cpuMs: number | null
  peakRssBytes: number | null
}

type ResourceDimension = 'job' | 'agent' | 'project'

function resourceGroups(rows: readonly RunResourceObservation[], dimension: ResourceDimension) {
  const groups = new Map<string, RunResourceObservation[]>()
  for (const row of rows) {
    const key = row[dimension]
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.entries()]
    .map(([name, group]) => {
      const measured = group.filter(
        (
          row,
        ): row is RunResourceObservation & {
          cpuMs: number
          peakRssBytes: number
        } => row.cpuMs !== null && row.peakRssBytes !== null,
      )
      const cpuMedian = nearestRankPercentile(
        measured.map((row) => row.cpuMs),
        0.5,
      )
      const cpuP90 = nearestRankPercentile(
        measured.map((row) => row.cpuMs),
        0.9,
      )
      return {
        [dimension]: name,
        runs: group.length,
        measuredRuns: measured.length,
        unmeasuredRuns: group.length - measured.length,
        cpuSeconds: {
          median: cpuMedian === null ? null : cpuMedian / 1_000,
          p90: cpuP90 === null ? null : cpuP90 / 1_000,
        },
        peakRssBytes: {
          median: nearestRankPercentile(
            measured.map((row) => row.peakRssBytes),
            0.5,
          ),
          p90: nearestRankPercentile(
            measured.map((row) => row.peakRssBytes),
            0.9,
          ),
        },
      }
    })
    .sort((a, b) => String(a[dimension]).localeCompare(String(b[dimension])))
}

export function runResourceReport(rows: readonly RunResourceObservation[]) {
  return {
    byJob: resourceGroups(rows, 'job'),
    byAgent: resourceGroups(rows, 'agent'),
    byProject: resourceGroups(rows, 'project'),
  }
}

export function loadRunResourceReport(database: Database, options: ReportFilterOptions) {
  const filter = reportFilter(options)
  const rows = database
    .query(
      `SELECT COALESCE(project.name,'(none)') project,r.job,r.agent,
              r.resource_cpu_ms cpu_ms,r.resource_peak_rss_bytes peak_rss_bytes
         FROM run r LEFT JOIN project ON project.record_id=r.project_record_id
        WHERE (? IS NULL OR project.name=?) AND (? IS NULL OR r.started_at>=?)
          AND (? IS NULL OR r.started_at<?)`,
    )
    .all(...filter.parameters) as Array<{
    project: string
    job: string
    agent: string
    cpu_ms: number | null
    peak_rss_bytes: number | null
  }>
  return runResourceReport(
    rows.map((row) => ({
      project: row.project,
      job: row.job,
      agent: row.agent,
      cpuMs: row.cpu_ms,
      peakRssBytes: row.peak_rss_bytes,
    })),
  )
}
