// concern: provisioning report adapter

import { parseBoardDuration } from '../../../shared/board-duration.ts'
import { db } from '../database/db.ts'
import { loadProvisioningReport } from './provisioning-report.ts'
import { loadRunResourceReport } from './run-resource-report.ts'

const mib = (bytes: number | null) => (bytes === null ? 'unknown' : (bytes / 1_048_576).toFixed(1))
const known = (value: number | null) => value ?? 'unknown'

export function formatRunResources(resources: ReturnType<typeof loadRunResourceReport>): string[] {
  type ResourceRow = {
    runs: number
    measuredRuns: number
    unmeasuredRuns: number
    cpuSeconds: { median: number | null; p90: number | null }
    peakRssBytes: { median: number | null; p90: number | null }
  }
  const section = <T extends ResourceRow>(label: string, rows: T[], name: (row: T) => string) => [
    `run resources by ${label}:`,
    ...(rows.length
      ? rows.map(
          (row) =>
            `${name(row)}: ${row.runs} run(s) (${row.measuredRuns} measured, ${row.unmeasuredRuns} unmeasured), CPU seconds median/p90 ${known(row.cpuSeconds.median)}/${known(row.cpuSeconds.p90)}, peak RSS MiB median/p90 ${mib(row.peakRssBytes.median)}/${mib(row.peakRssBytes.p90)}`,
        )
      : ['no runs']),
  ]
  return [
    ...section('job', resources.byJob, (row) => String(row.job)),
    ...section('agent', resources.byAgent, (row) => String(row.agent)),
    ...section('project', resources.byProject, (row) => String(row.project)),
  ]
}

export async function provisioningCommand(
  options: {
    project?: string
    since?: string
    json: boolean
    resources: boolean
  },
  presentation: { write(value: string): Promise<void> },
): Promise<void> {
  const sinceMs = options.since ? parseBoardDuration(options.since) : null
  if (options.resources) {
    const resources = loadRunResourceReport(db(), {
      project: options.project,
      sinceMs,
    })
    return presentation.write(
      options.json
        ? `${JSON.stringify(resources)}\n`
        : `${formatRunResources(resources).join('\n')}\n`,
    )
  }
  const report = loadProvisioningReport(db(), {
    project: options.project,
    sinceMs,
  })
  if (options.json) return presentation.write(`${JSON.stringify(report)}\n`)
  const provisioningLines = report.length
    ? report.map(
        (row) =>
          `${row.project} ${row.kind}: ${row.runs} run(s) (${row.outcomes.ok} ok, ${row.outcomes.failed} failed), provisioning median/p90 ${row.provisioningMs.median}/${row.provisioningMs.p90}ms, entries median/p90 ${row.entries.median ?? 'unknown'}/${row.entries.p90 ?? 'unknown'}${row.entries.limitedRuns ? ` (${row.entries.limitedRuns} bounded)` : ''}${row.entries.unavailableRuns ? ` (${row.entries.unavailableRuns} unavailable)` : ''}; host load ${row.hostLoad.oneMinute.min}-${row.hostLoad.oneMinute.max}; ${row.comparison}`,
      )
    : ['no provisioning samples']
  await presentation.write(`${provisioningLines.join('\n')}\n`)
}
