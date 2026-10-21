// concern: provisioning report adapter

import { parseBoardDuration } from '../../../shared/board-duration.ts'
import { db } from '../database/db.ts'
import { loadProvisioningReport } from './provisioning-report.ts'
import { loadRunResourceReport } from './run-resource-report.ts'

const mib = (bytes: number | null) => (bytes === null ? 'unknown' : (bytes / 1_048_576).toFixed(1))

export async function provisioningCommand(
  options: { project?: string; since?: string; json: boolean },
  presentation: { write(value: string): Promise<void> },
): Promise<void> {
  const sinceMs = options.since ? parseBoardDuration(options.since) : null
  const report = loadProvisioningReport(db(), { project: options.project, sinceMs })
  const resources = loadRunResourceReport(db(), { project: options.project, sinceMs })
  if (options.json)
    return presentation.write(
      `${JSON.stringify({ provisioning: report, runResources: resources })}\n`,
    )
  const provisioningLines = report.length
    ? report.map(
        (row) =>
          `${row.project} ${row.kind}: ${row.runs} run(s) (${row.outcomes.ok} ok, ${row.outcomes.failed} failed), provisioning median/p90 ${row.provisioningMs.median}/${row.provisioningMs.p90}ms, entries median/p90 ${row.entries.median ?? 'unknown'}/${row.entries.p90 ?? 'unknown'}${row.entries.limitedRuns ? ` (${row.entries.limitedRuns} bounded)` : ''}${row.entries.unavailableRuns ? ` (${row.entries.unavailableRuns} unavailable)` : ''}; host load ${row.hostLoad.oneMinute.min}-${row.hostLoad.oneMinute.max}; ${row.comparison}`,
      )
    : ['no provisioning samples']
  const resourceLines = [
    'run resources by job:',
    ...(resources.byJob.length
      ? resources.byJob.map(
          (row) =>
            `${row.job}: ${row.runs} run(s), CPU seconds median/p90 ${row.cpuSeconds.median}/${row.cpuSeconds.p90}, peak RSS MiB median/p90 ${mib(row.peakRssBytes.median)}/${mib(row.peakRssBytes.p90)}`,
        )
      : ['no run resource samples']),
    'run resources by agent:',
    ...(resources.byAgent.length
      ? resources.byAgent.map(
          (row) =>
            `${row.agent}: ${row.runs} run(s), CPU seconds median/p90 ${row.cpuSeconds.median}/${row.cpuSeconds.p90}, peak RSS MiB median/p90 ${mib(row.peakRssBytes.median)}/${mib(row.peakRssBytes.p90)}`,
        )
      : ['no run resource samples']),
    'run resources by project:',
    ...(resources.byProject.length
      ? resources.byProject.map(
          (row) =>
            `${row.project}: ${row.runs} run(s), CPU seconds median/p90 ${row.cpuSeconds.median}/${row.cpuSeconds.p90}, peak RSS MiB median/p90 ${mib(row.peakRssBytes.median)}/${mib(row.peakRssBytes.p90)}`,
        )
      : ['no run resource samples']),
  ]
  await presentation.write(`${[...provisioningLines, ...resourceLines].join('\n')}\n`)
}
