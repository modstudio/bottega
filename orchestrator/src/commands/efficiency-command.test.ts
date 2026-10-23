import { expect, test } from 'bun:test'
import type { CycleCostWindowReport } from '../evidence/cycle-cost.ts'
import { provisioningReport } from '../monitor/provisioning-report.ts'
import {
  efficiencyWindows,
  formatCycleWindow,
  formatHostPressure,
  formatProvisioning,
  formatUseful,
  selectedEfficiencySections,
} from './efficiency-command.ts'

test('efficiency windows default to adjacent seven-day periods', () => {
  expect(efficiencyWindows(undefined, Date.parse('2026-10-15T00:00:00Z'))).toEqual({
    currentWindow: {
      start: '2026-10-08T00:00:00.000Z',
      end: '2026-10-15T00:00:00.000Z',
    },
    previousWindow: {
      start: '2026-10-01T00:00:00.000Z',
      end: '2026-10-08T00:00:00.000Z',
    },
  })
})

test('section selection follows report order', () => {
  expect(selectedEfficiencySections(['cycle-cost', 'provisioning'])).toEqual([
    'provisioning',
    'cycle-cost',
  ])
})

test('provisioning formatting retains outcomes, entries, host load, and comparison', () => {
  const rows = provisioningReport([
    {
      project: 'app',
      kind: 'writer',
      outcome: 'failed',
      durationMs: 120,
      entries: null,
      entriesLimited: true,
      hostLoad: {
        gates: 0,
        loadavg: 3,
        ncpu: 8,
        freeMem: 1,
        pressure: 'normal',
        swapUsed: 0,
        swapTotal: 0,
        recentAdmissions: 0,
        waitingRequests: 0,
        oldestWaitMs: 0,
        liveRuns: 1,
      },
    },
  ])
  expect(
    formatProvisioning('Current', {
      window: { start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z' },
      rows,
    }).join('\n'),
  ).toContain(
    '1 run(s) (0 ok, 1 failed), provisioning median/p90 120/120ms, entries median/p90 unknown/unknown (1 bounded) (1 unavailable); host load 3-3; sample too small to compare (1/5 runs)',
  )
})

test('cost-per-result formatting states priced and timed hit coverage', () => {
  const output = formatUseful('Current', {
    window: { start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z' },
    completedReviews: true,
    lenses: [
      {
        key: 'craft',
        runs: 3,
        hits: 2,
        costPerHit: 1.25,
        pricedHits: 1,
        minutesPerHit: 4.5,
        timedHits: 2,
      },
    ],
    agents: [],
  }).join('\n')
  expect(output).toContain('cost/hit $1.25 (1/2 priced)')
  expect(output).toContain('min/hit 4.50 (2/2 timed)')
})

test('zero-task cycle formatting retains nonzero unattributed and runless counts', () => {
  const aggregate = { median: null, p90: null, total: null }
  const report: CycleCostWindowReport = {
    window: { start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z' },
    aggregates: {
      landedTasks: 0,
      reviewRounds: aggregate,
      fixTurns: aggregate,
      ciRuns: aggregate,
      reruns: aggregate,
      flakeAttributedReruns: aggregate,
      dispatchToMergeHours: aggregate,
      unknownCiTasks: 0,
      unattributedLandings: 2,
      tasksWithoutRuns: 1,
    },
    tasks: [],
    unattributedLandings: [],
  }
  expect(formatCycleWindow('Current', report)).toEqual([
    'Current: no landed tasks',
    '  unattributed landings: 2',
    '  tasks without runs: 1',
  ])
})

test('host-pressure formatting names retained coverage and empty windows honestly', () => {
  const window = { start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z' }
  const base = {
    window,
    loadAveragePerCpu: { median: 0.5, p90: 1 },
    pressureLevels: [],
    contentions: [],
  }
  expect(
    formatHostPressure('Current', {
      ...base,
      sampleCount: 2,
      sampleSpan: {
        start: '2026-10-07T23:45:00.000Z',
        end: '2026-10-08T00:00:00.000Z',
      },
    }).join('\n'),
  ).toContain('sample coverage is shorter than the window (15-minute retention)')
  expect(
    formatHostPressure('Previous', {
      ...base,
      sampleCount: 0,
      sampleSpan: null,
      loadAveragePerCpu: { median: null, p90: null },
    }).join('\n'),
  ).toContain('samples: no retained samples (15-minute retention)')
})
