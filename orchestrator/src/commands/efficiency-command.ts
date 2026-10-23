// concern: machine efficiency command
/** Parses the report window and presents efficiency sections. */

import { parseBoardDuration } from '../../../shared/board-duration.ts'
import { db } from '../database/db.ts'
import type { CycleCostMetricAggregate, CycleCostWindowReport } from '../evidence/cycle-cost.ts'
import { loadCycleCostReport } from '../evidence/cycle-cost-service.ts'

const DEFAULT_EFFICIENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000

export function efficiencyWindows(since: string | undefined, now: number) {
  const windowMs = since ? parseBoardDuration(since) : DEFAULT_EFFICIENCY_WINDOW_MS
  const currentWindow = {
    start: new Date(now - windowMs).toISOString(),
    end: new Date(now).toISOString(),
  }
  return {
    currentWindow,
    previousWindow: {
      start: new Date(now - windowMs * 2).toISOString(),
      end: currentWindow.start,
    },
  }
}

const amount = (value: number | null, hours = false): string => {
  if (value === null) return 'unknown'
  if (!hours) return String(value)
  return value
    .toFixed(2)
    .replace(/\.00$/, '')
    .replace(/(\.\d)0$/, '$1')
}

const metric = (label: string, values: CycleCostMetricAggregate, hours = false) =>
  `${label}${hours ? ' (hours)' : ''}: median ${amount(values.median, hours)}, p90 ${amount(values.p90, hours)}, total ${amount(values.total, hours)}`

function formatWindow(label: string, report: CycleCostWindowReport): string[] {
  if (!report.aggregates.landedTasks)
    return [
      `${label}: no landed tasks`,
      ...(report.aggregates.unattributedLandings
        ? [`  unattributed landings: ${report.aggregates.unattributedLandings}`]
        : []),
    ]
  return [
    `${label}: ${report.aggregates.landedTasks} landed task(s)`,
    metric('  review rounds', report.aggregates.reviewRounds),
    metric('  fix turns', report.aggregates.fixTurns),
    metric('  CI runs', report.aggregates.ciRuns),
    metric('  reruns', report.aggregates.reruns),
    metric('  flake-attributed reruns', report.aggregates.flakeAttributedReruns),
    metric('  dispatch to merge', report.aggregates.dispatchToMergeHours, true),
    `  tasks with unknown CI: ${report.aggregates.unknownCiTasks}`,
    `  unattributed landings: ${report.aggregates.unattributedLandings}`,
    `  tasks without runs: ${report.aggregates.tasksWithoutRuns}`,
  ]
}

function formatCycleCost(report: ReturnType<typeof loadCycleCostReport>): string[] {
  return [
    'Cycle cost',
    `Current window: ${report.current.window.start} to ${report.current.window.end}`,
    `Previous window: ${report.previous.window.start} to ${report.previous.window.end}`,
    ...formatWindow('Current', report.current),
    ...formatWindow('Previous', report.previous),
  ]
}

export async function efficiencyCommand(
  options: { since?: string; json: boolean },
  presentation: { write(value: string): Promise<void> },
  now = Date.now(),
): Promise<void> {
  const { currentWindow, previousWindow } = efficiencyWindows(options.since, now)
  const report = loadCycleCostReport(db(), { currentWindow, previousWindow })
  await presentation.write(
    options.json ? `${JSON.stringify(report)}\n` : `${formatCycleCost(report).join('\n')}\n`,
  )
}
