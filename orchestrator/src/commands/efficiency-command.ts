// concern: machine efficiency command
/** Selects, loads, and presents the six local efficiency sections. */

import type { Database } from 'bun:sqlite'
import { parseBoardDuration } from '../../../shared/board-duration.ts'
import { db } from '../database/db.ts'
import type { CycleCostMetricAggregate, CycleCostWindowReport } from '../evidence/cycle-cost.ts'
import { loadCycleCostReport } from '../evidence/cycle-cost-service.ts'
import { loadWastedTimeReport } from '../health/wasted-time-report.ts'
import { HOST_PRESSURE_SAMPLE_RETENTION_MS } from '../host-pressure/host-pressure-decision.ts'
import { loadHostPressureReport } from '../host-pressure/host-pressure-report.ts'
import { loadProvisioningReport } from '../monitor/provisioning-report.ts'
import { loadRunResourceReport } from '../monitor/run-resource-report.ts'
import { loadReviewYieldEfficiencyReport } from '../review/review-yield-efficiency-report.ts'

const DEFAULT_EFFICIENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000
type Window = { start: string; end: string }
type Windows = { currentWindow: Window; previousWindow: Window }

export function efficiencyWindows(since: string | undefined, now: number): Windows {
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

export function formatCycleWindow(label: string, report: CycleCostWindowReport): string[] {
  if (!report.aggregates.landedTasks)
    return [
      `${label}: no landed tasks`,
      ...(report.aggregates.unattributedLandings
        ? [`  unattributed landings: ${report.aggregates.unattributedLandings}`]
        : []),
      ...(report.aggregates.tasksWithoutRuns
        ? [`  tasks without runs: ${report.aggregates.tasksWithoutRuns}`]
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

const withWindow = <T extends object>(window: Window, value: T) => ({ window, ...value })
const windowLines = (label: string, value: { window: Window }, lines: string[]) => [
  `${label} window: ${value.window.start} to ${value.window.end}`,
  ...lines,
]
const pairLines = <T>(
  section: { current: T; previous: T },
  format: (label: string, value: T) => string[],
) => [...format('Current', section.current), ...format('Previous', section.previous)]

type ProvisioningWindow = { window: Window; rows: ReturnType<typeof loadProvisioningReport> }
type ResourceWindow = { window: Window } & ReturnType<typeof loadRunResourceReport>
type HostPressureSection = ReturnType<typeof loadHostPressureReport>
type WastedTimeSection = ReturnType<typeof loadWastedTimeReport>
type UsefulSection = Awaited<ReturnType<typeof loadReviewYieldEfficiencyReport>>

export const formatProvisioning = (label: string, value: ProvisioningWindow) =>
  windowLines(
    label,
    value,
    value.rows.length
      ? value.rows.map(
          (row) =>
            `${row.project} ${row.kind}: ${row.runs} run(s) (${row.outcomes.ok} ok, ${row.outcomes.failed} failed), provisioning median/p90 ${row.provisioningMs.median}/${row.provisioningMs.p90}ms, entries median/p90 ${row.entries.median ?? 'unknown'}/${row.entries.p90 ?? 'unknown'}${row.entries.limitedRuns ? ` (${row.entries.limitedRuns} bounded)` : ''}${row.entries.unavailableRuns ? ` (${row.entries.unavailableRuns} unavailable)` : ''}; host load ${row.hostLoad.oneMinute.min}-${row.hostLoad.oneMinute.max}; ${row.comparison}`,
        )
      : ['no provisioning samples'],
  )

function formatResources(label: string, value: ResourceWindow): string[] {
  const lines = value.byJob.map(
    (row) =>
      `    ${row.job}: ${row.runs} run(s), CPU seconds median/p90 ${amount(row.cpuSeconds.median)}/${amount(row.cpuSeconds.p90)}, peak RSS bytes median/p90 ${amount(row.peakRssBytes.median)}/${amount(row.peakRssBytes.p90)}`,
  )
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

const retentionMinutes = HOST_PRESSURE_SAMPLE_RETENTION_MS / 60_000
export const formatHostPressure = (label: string, report: HostPressureSection['current']) => {
  const sampleLines = report.sampleSpan
    ? [
        `  samples: ${report.sampleCount}, retained span ${report.sampleSpan.start} to ${report.sampleSpan.end}`,
        ...(Date.parse(report.sampleSpan.end) - Date.parse(report.sampleSpan.start) <
        Date.parse(report.window.end) - Date.parse(report.window.start)
          ? [`  sample coverage is shorter than the window (${retentionMinutes}-minute retention)`]
          : []),
        `  load average per CPU median/p90: ${amount(report.loadAveragePerCpu.median)}/${amount(report.loadAveragePerCpu.p90)}`,
        ...report.pressureLevels.map(
          (row) => `  pressure ${row.level}: ${(row.share * 100).toFixed(1)}% (${row.count})`,
        ),
      ]
    : [`  samples: no retained samples (${retentionMinutes}-minute retention)`]
  return windowLines(label, report, [
    ...sampleLines,
    ...report.contentions.map(
      (row) =>
        `  ${row.kind}: ${row.waits} wait(s), median ${duration(row.medianWaitMs)}, total ${duration(row.totalWaitMs)}`,
    ),
  ])
}

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

export function formatUseful(label: string, report: UsefulSection['current']): string[] {
  const lines = [`${label} window: ${report.window.start} to ${report.window.end}`]
  if (!report.completedReviews) return [...lines, `${label}: no completed reviews`]
  for (const [groupLabel, rows] of [
    ['By lens', report.lenses],
    ['By agent', report.agents],
  ] as const) {
    lines.push(`  ${groupLabel}`)
    for (const row of rows)
      lines.push(
        `    ${row.key}: ${row.runs} runs, ${row.hits} hits, cost/hit ${row.costPerHit === null ? 'unknown' : `$${row.costPerHit.toFixed(2)}`} (${row.pricedHits}/${row.hits} priced), min/hit ${row.minutesPerHit === null ? 'unknown' : row.minutesPerHit.toFixed(2)} (${row.timedHits}/${row.hits} timed)`,
      )
  }
  return lines
}

type SectionContext = { database: Database; windows: Windows; project?: string }
type SectionDescriptor<Name extends string, Report> = {
  name: Name
  title: string
  load(context: SectionContext): Report | Promise<Report>
  format(report: Report, context: SectionContext): string[]
}
const defineSection = <Name extends string, Report>(
  descriptor: SectionDescriptor<Name, Report>,
) => ({
  name: descriptor.name,
  title: descriptor.title,
  async run(context: SectionContext) {
    const value = await descriptor.load(context)
    return { value, lines: descriptor.format(value, context) }
  },
})

const sectionDescriptors = [
  defineSection({
    name: 'provisioning',
    title: 'Provisioning',
    load: ({ database, windows, project }) => ({
      current: withWindow(windows.currentWindow, {
        rows: loadProvisioningReport(database, {
          project,
          since: windows.currentWindow.start,
          until: windows.currentWindow.end,
        }),
      }),
      previous: withWindow(windows.previousWindow, {
        rows: loadProvisioningReport(database, {
          project,
          since: windows.previousWindow.start,
          until: windows.previousWindow.end,
        }),
      }),
    }),
    format: (report) => pairLines(report, formatProvisioning),
  }),
  defineSection({
    name: 'resources',
    title: 'Run resources',
    load: ({ database, windows, project }) => ({
      current: withWindow(
        windows.currentWindow,
        loadRunResourceReport(database, {
          project,
          since: windows.currentWindow.start,
          until: windows.currentWindow.end,
        }),
      ),
      previous: withWindow(
        windows.previousWindow,
        loadRunResourceReport(database, {
          project,
          since: windows.previousWindow.start,
          until: windows.previousWindow.end,
        }),
      ),
    }),
    format: (report) => pairLines(report, formatResources),
  }),
  defineSection({
    name: 'host-pressure',
    title: 'Host pressure',
    load: ({ database, windows }) => loadHostPressureReport(database, windows),
    format: (report, context) => [
      ...(context.project ? ['Project filtering is unavailable for host-pressure evidence.'] : []),
      ...pairLines(report, formatHostPressure),
    ],
  }),
  defineSection({
    name: 'wasted-time',
    title: 'Wasted time',
    load: ({ database, windows, project }) => loadWastedTimeReport(database, windows, project),
    format: (report) => pairLines(report, formatWastedTime),
  }),
  defineSection({
    name: 'cycle-cost',
    title: 'Cycle cost',
    load: ({ database, windows, project }) =>
      loadCycleCostReport(database, { ...windows, project }),
    format: (report) => pairLines(report, formatCycleCost),
  }),
  defineSection({
    name: 'cost-per-result',
    title: 'Cost per useful result',
    load: ({ database, windows, project }) =>
      loadReviewYieldEfficiencyReport(database, windows, project),
    format: (report) => pairLines(report, formatUseful),
  }),
] as const

export type EfficiencySection = (typeof sectionDescriptors)[number]['name']

export function selectedEfficiencySections(
  names: readonly string[] | undefined,
): EfficiencySection[] {
  const all = sectionDescriptors.map((descriptor) => descriptor.name)
  if (!names?.length) return all
  const invalid = names.filter((name) => !all.includes(name as EfficiencySection))
  if (invalid.length) throw new Error(`unknown efficiency section: ${invalid.join(', ')}`)
  return all.filter((name) => names.includes(name))
}

export async function efficiencyCommand(
  options: { since?: string; json: boolean; sections?: readonly string[]; project?: string },
  presentation: { write(value: string): Promise<void> },
  now = Date.now(),
): Promise<void> {
  const selected = selectedEfficiencySections(options.sections)
  const context = {
    database: db(),
    windows: efficiencyWindows(options.since, now),
    project: options.project,
  }
  const results = []
  for (const descriptor of sectionDescriptors) {
    if (!selected.includes(descriptor.name)) continue
    const result = await descriptor.run(context)
    results.push({
      name: descriptor.name,
      value: result.value,
      lines: [descriptor.title, ...result.lines],
    })
  }
  const report = Object.fromEntries(results.map((result) => [result.name, result.value]))
  await presentation.write(
    options.json
      ? `${JSON.stringify(report)}\n`
      : `${results.flatMap((result, index) => [...(index ? [''] : []), ...result.lines]).join('\n')}\n`,
  )
}
