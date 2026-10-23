// concern: machine efficiency command
/** Selects, loads, and presents the six local efficiency sections. */

import { parseBoardDuration } from '../../../shared/board-duration.ts'
import { db } from '../database/db.ts'
import type { CycleCostMetricAggregate, CycleCostWindowReport } from '../evidence/cycle-cost.ts'
import { loadCycleCostReport } from '../evidence/cycle-cost-service.ts'
import { loadWastedTimeReport } from '../health/wasted-time-report.ts'
import { loadHostPressureReport } from '../host-pressure/host-pressure-report.ts'
import { loadProvisioningReport } from '../monitor/provisioning-report.ts'
import { loadRunResourceReport } from '../monitor/run-resource-report.ts'
import { type ReviewYieldReport, reviewYield } from '../review/review-yield.ts'
import { loadSubscriptionCostContext } from '../run/run-subscription-prices.ts'

const DEFAULT_EFFICIENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000
const EFFICIENCY_SECTIONS = [
  'provisioning',
  'resources',
  'host-pressure',
  'wasted-time',
  'cycle-cost',
  'cost-per-result',
] as const
export type EfficiencySection = (typeof EFFICIENCY_SECTIONS)[number]
type Window = { start: string; end: string }

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

export function selectedEfficiencySections(
  names: readonly string[] | undefined,
): EfficiencySection[] {
  if (!names?.length) return [...EFFICIENCY_SECTIONS]
  const invalid = names.filter(
    (name): name is string => !EFFICIENCY_SECTIONS.includes(name as EfficiencySection),
  )
  if (invalid.length) throw new Error(`unknown efficiency section: ${invalid.join(', ')}`)
  return EFFICIENCY_SECTIONS.filter((name) => names.includes(name))
}

export function provisioningAliasOptions(options: {
  project?: string
  since?: string
  json: boolean
  resources: boolean
}) {
  return {
    project: options.project,
    since: options.since,
    json: options.json,
    sections: [options.resources ? 'resources' : 'provisioning'],
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
const duration = (ms: number | null) => (ms === null ? 'unknown' : `${amount(ms)}ms`)
const metric = (label: string, values: CycleCostMetricAggregate, hours = false) =>
  `${label}${hours ? ' (hours)' : ''}: median ${amount(values.median, hours)}, p90 ${amount(values.p90, hours)}, total ${amount(values.total, hours)}`

function formatCycleWindow(label: string, report: CycleCostWindowReport): string[] {
  if (!report.aggregates.landedTasks) return [`${label}: no landed tasks`]
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

type UsefulResultRow = Pick<
  ReviewYieldReport['lenses'][number],
  'key' | 'runs' | 'hits' | 'costPerHit' | 'pricedHits' | 'minutesPerHit' | 'timedHits'
>
const usefulRows = (rows: ReviewYieldReport['lenses']): UsefulResultRow[] =>
  rows
    .map(({ key, runs, hits, costPerHit, pricedHits, minutesPerHit, timedHits }) => ({
      key,
      runs,
      hits,
      costPerHit,
      pricedHits,
      minutesPerHit,
      timedHits,
    }))
    .sort((a, b) => b.hits - a.hits || a.key.localeCompare(b.key))
const usefulWindow = (window: Window, report: ReviewYieldReport) => ({
  window,
  completedReviews: report.lenses.some((row) => row.reviews.completed > 0),
  lenses: usefulRows(report.lenses),
  agents: usefulRows(report.agents),
})

const withWindow = <T extends object>(window: Window, value: T) => ({ window, ...value })
const windowLines = (label: string, value: { window: Window }, lines: string[]) => [
  `${label} window: ${value.window.start} to ${value.window.end}`,
  ...lines,
]

type ProvisioningWindow = { window: Window; rows: ReturnType<typeof loadProvisioningReport> }
type ResourceWindow = { window: Window } & ReturnType<typeof loadRunResourceReport>
type HostPressureSection = ReturnType<typeof loadHostPressureReport> & {
  projectFilterUnsupported?: string
}
type WastedTimeSection = ReturnType<typeof loadWastedTimeReport>
type UsefulSection = {
  current: ReturnType<typeof usefulWindow>
  previous: ReturnType<typeof usefulWindow>
}

const formatProvisioning = (label: string, value: ProvisioningWindow) =>
  windowLines(
    label,
    value,
    value.rows.length
      ? value.rows.map(
          (row) =>
            `${row.project} ${row.kind}: ${row.runs} run(s), provisioning median/p90 ${duration(row.provisioningMs.median)}/${duration(row.provisioningMs.p90)}`,
        )
      : ['no provisioning samples'],
  )

function formatResources(label: string, value: ResourceWindow): string[] {
  const lines = [
    ...value.byJob.map(
      (row) =>
        `    ${row.job}: ${row.runs} run(s), CPU seconds median/p90 ${amount(row.cpuSeconds.median)}/${amount(row.cpuSeconds.p90)}, peak RSS bytes median/p90 ${amount(row.peakRssBytes.median)}/${amount(row.peakRssBytes.p90)}`,
    ),
  ]
  return windowLines(label, value, [
    '  by job:',
    ...(lines.length ? lines : ['    no runs']),
    '  by agent:',
    ...(value.byAgent.length
      ? value.byAgent.map(
          (row) =>
            `    ${row.agent}: ${row.runs} run(s), CPU seconds median/p90 ${amount(row.cpuSeconds.median)}/${amount(row.cpuSeconds.p90)}, peak RSS bytes median/p90 ${amount(row.peakRssBytes.median)}/${amount(row.peakRssBytes.p90)}`,
        )
      : ['    no runs']),
    '  by project:',
    ...(value.byProject.length
      ? value.byProject.map(
          (row) =>
            `    ${row.project}: ${row.runs} run(s), CPU seconds median/p90 ${amount(row.cpuSeconds.median)}/${amount(row.cpuSeconds.p90)}, peak RSS bytes median/p90 ${amount(row.peakRssBytes.median)}/${amount(row.peakRssBytes.p90)}`,
        )
      : ['    no runs']),
  ])
}

const pairLines = <T>(
  section: { current: T; previous: T },
  format: (label: string, value: T) => string[],
) => [...format('Current', section.current), ...format('Previous', section.previous)]

const formatHostPressure = (label: string, report: HostPressureSection['current']) =>
  windowLines(label, report, [
    `  samples: ${report.sampleCount}`,
    `  load average per CPU median/p90: ${amount(report.loadAveragePerCpu.median)}/${amount(report.loadAveragePerCpu.p90)}`,
    ...report.pressureLevels.map(
      (row) => `  pressure ${row.level}: ${(row.share * 100).toFixed(1)}% (${row.count})`,
    ),
    ...report.contentions.map(
      (row) =>
        `  ${row.kind}: ${row.waits} wait(s), median ${duration(row.medianWaitMs)}, total ${duration(row.totalWaitMs)}`,
    ),
  ])

const formatWastedTime = (label: string, report: WastedTimeSection['current']) =>
  windowLines(
    label,
    report,
    report.classes.map((row) => `  ${row.kind}: ${row.count}, total ${duration(row.totalTimeMs)}`),
  )

const formatCycleCost = (label: string, report: CycleCostWindowReport) => [
  `${label} window: ${report.window.start} to ${report.window.end}`,
  ...formatCycleWindow(label, report),
]

function formatUseful(label: string, report: UsefulSection['current']): string[] {
  const lines = [`${label} window: ${report.window.start} to ${report.window.end}`]
  if (!report.completedReviews) return [...lines, `${label}: no completed reviews`]
  for (const [groupLabel, rows] of [
    ['By lens', report.lenses],
    ['By agent', report.agents],
  ] as const) {
    lines.push(`  ${groupLabel}`)
    for (const row of rows)
      lines.push(
        `    ${row.key}: ${row.runs} runs, ${row.hits} hits, cost/hit ${row.costPerHit === null ? 'unknown' : `$${row.costPerHit.toFixed(2)}`}, min/hit ${row.minutesPerHit === null ? 'unknown' : row.minutesPerHit.toFixed(2)}`,
      )
  }
  return lines
}

function sectionLines(name: EfficiencySection, section: unknown): string[] {
  if (name === 'provisioning')
    return [
      'Provisioning',
      ...pairLines(
        section as { current: ProvisioningWindow; previous: ProvisioningWindow },
        formatProvisioning,
      ),
    ]
  if (name === 'resources')
    return [
      'Run resources',
      ...pairLines(
        section as { current: ResourceWindow; previous: ResourceWindow },
        formatResources,
      ),
    ]
  if (name === 'host-pressure') {
    const report = section as HostPressureSection
    return [
      'Host pressure',
      ...(report.projectFilterUnsupported ? [report.projectFilterUnsupported] : []),
      ...pairLines(report, formatHostPressure),
    ]
  }
  if (name === 'wasted-time')
    return ['Wasted time', ...pairLines(section as WastedTimeSection, formatWastedTime)]
  if (name === 'cycle-cost')
    return [
      'Cycle cost',
      ...pairLines(section as ReturnType<typeof loadCycleCostReport>, formatCycleCost),
    ]
  return ['Cost per useful result', ...pairLines(section as UsefulSection, formatUseful)]
}

export async function efficiencyCommand(
  options: { since?: string; json: boolean; sections?: readonly string[]; project?: string },
  presentation: { write(value: string): Promise<void> },
  now = Date.now(),
): Promise<void> {
  const windows = efficiencyWindows(options.since, now)
  const selected = selectedEfficiencySections(options.sections)
  const database = db()
  const report: Partial<Record<EfficiencySection, unknown>> = {}
  for (const section of selected) {
    if (section === 'provisioning') {
      report[section] = {
        current: withWindow(windows.currentWindow, {
          rows: loadProvisioningReport(database, {
            project: options.project,
            since: windows.currentWindow.start,
            until: windows.currentWindow.end,
          }),
        }),
        previous: withWindow(windows.previousWindow, {
          rows: loadProvisioningReport(database, {
            project: options.project,
            since: windows.previousWindow.start,
            until: windows.previousWindow.end,
          }),
        }),
      }
    } else if (section === 'resources') {
      report[section] = {
        current: withWindow(
          windows.currentWindow,
          loadRunResourceReport(database, {
            project: options.project,
            since: windows.currentWindow.start,
            until: windows.currentWindow.end,
          }),
        ),
        previous: withWindow(
          windows.previousWindow,
          loadRunResourceReport(database, {
            project: options.project,
            since: windows.previousWindow.start,
            until: windows.previousWindow.end,
          }),
        ),
      }
    } else if (section === 'host-pressure') {
      report[section] = {
        ...loadHostPressureReport(database, windows),
        ...(options.project
          ? {
              projectFilterUnsupported:
                'Project filtering is unavailable for host-pressure evidence.',
            }
          : {}),
      }
    } else if (section === 'wasted-time') {
      report[section] = loadWastedTimeReport(database, windows, options.project)
    } else if (section === 'cycle-cost') {
      report[section] = loadCycleCostReport(database, { ...windows, project: options.project })
    } else {
      const subscriptionCost = await loadSubscriptionCostContext()
      report[section] = {
        current: usefulWindow(
          windows.currentWindow,
          reviewYield(
            {
              project: options.project,
              since: windows.currentWindow.start,
              until: windows.currentWindow.end,
            },
            database,
            subscriptionCost,
          ),
        ),
        previous: usefulWindow(
          windows.previousWindow,
          reviewYield(
            {
              project: options.project,
              since: windows.previousWindow.start,
              until: windows.previousWindow.end,
            },
            database,
            subscriptionCost,
          ),
        ),
      }
    }
  }
  await presentation.write(
    options.json
      ? `${JSON.stringify(report)}\n`
      : `${selected
          .flatMap((name, index) => [...(index ? [''] : []), ...sectionLines(name, report[name])])
          .join('\n')}\n`,
  )
}
