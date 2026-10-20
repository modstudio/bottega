// concern: provisioning report adapter

import { parseBoardDuration } from '../../../shared/board-duration.ts'
import { db } from '../database/db.ts'
import { loadProvisioningReport } from './provisioning-report.ts'

export async function provisioningCommand(
  options: { project?: string; since?: string; json: boolean },
  presentation: { write(value: string): Promise<void> },
): Promise<void> {
  const sinceMs = options.since ? parseBoardDuration(options.since) : null
  const report = loadProvisioningReport(db(), { project: options.project, sinceMs })
  if (options.json) return presentation.write(`${JSON.stringify(report)}\n`)
  const lines = report.length
    ? report.map(
        (row) =>
          `${row.project} ${row.kind}: ${row.runs} run(s) (${row.outcomes.ok} ok, ${row.outcomes.failed} failed), provisioning median/p90 ${row.provisioningMs.median}/${row.provisioningMs.p90}ms, entries median/p90 ${row.entries.median ?? 'unknown'}/${row.entries.p90 ?? 'unknown'}${row.entries.limitedRuns ? ` (${row.entries.limitedRuns} bounded)` : ''}${row.entries.unavailableRuns ? ` (${row.entries.unavailableRuns} unavailable)` : ''}; host load ${row.hostLoad.oneMinute.min}-${row.hostLoad.oneMinute.max}; ${row.comparison}`,
      )
    : ['no provisioning samples']
  await presentation.write(`${lines.join('\n')}\n`)
}
