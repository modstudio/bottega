import { describe, expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import {
  type CycleCostCiRecord,
  type CycleCostLanding,
  type CycleCostReviewRound,
  type CycleCostRun,
  deriveCycleCost,
} from './cycle-cost.ts'

const currentWindow = { start: '2026-10-08T00:00:00.000Z', end: '2026-10-15T00:00:00.000Z' }
const previousWindow = { start: '2026-10-01T00:00:00.000Z', end: currentWindow.start }

const landing = (
  taskKey: string,
  mergedAt: string,
  pullRequestNumber: number,
  branch = taskKey,
): CycleCostLanding => ({
  project: PLATFORM_NAME,
  taskKey,
  branch,
  pullRequestNumber,
  mergedAt,
})

const run = (taskKey: string, startedAt: string, turn = 1, job = 'implement'): CycleCostRun => ({
  project: PLATFORM_NAME,
  taskKey,
  startedAt,
  turn,
  job,
})

const ci = (
  pullRequestNumber: number,
  workflowRunId: number,
  runAttempt = 1,
  conclusion = 'success',
): CycleCostCiRecord => ({
  project: PLATFORM_NAME,
  pullRequestNumber,
  recordKind: 'attempt',
  complete: null,
  workflowRunId,
  runAttempt,
  headCommit: 'head',
  conclusion,
})

const collection = (pullRequestNumber: number, complete: boolean): CycleCostCiRecord => ({
  project: PLATFORM_NAME,
  pullRequestNumber,
  recordKind: 'collection',
  complete,
  workflowRunId: null,
  runAttempt: null,
  headCommit: null,
  conclusion: null,
})

const derive = (input: {
  landings: CycleCostLanding[]
  runs: CycleCostRun[]
  reviewRounds?: CycleCostReviewRound[]
  ciRecords?: CycleCostCiRecord[]
}) =>
  deriveCycleCost({
    currentWindow,
    previousWindow,
    reviewRounds: [],
    ciRecords: [],
    ...input,
  })

describe('cycle cost', () => {
  test('aggregates nearest-rank median, p90, and totals over several tasks', () => {
    const landings = [
      landing('DEV-1', '2026-10-10T00:00:00Z', 11),
      landing('DEV-2', '2026-10-11T00:00:00Z', 12),
      landing('DEV-3', '2026-10-12T00:00:00Z', 13),
      landing('DEV-4', '2026-10-13T00:00:00Z', 14),
    ]
    const runs = landings.flatMap((row, index) => [
      run(row.taskKey, '2026-10-09T00:00:00Z'),
      ...Array.from({ length: index + 1 }, (_, turn) =>
        run(row.taskKey, '2026-10-09T01:00:00Z', turn + 2),
      ),
    ])
    const ciRecords = landings.flatMap((row, index) => [
      collection(row.pullRequestNumber, true),
      ...Array.from({ length: index + 1 }, (_, id) => ci(row.pullRequestNumber, index * 10 + id)),
    ])
    const report = derive({ landings, runs, ciRecords })

    expect(report.current.aggregates.fixTurns).toEqual({ median: 2, p90: 4, total: 10 })
    expect(report.current.aggregates.ciRuns).toEqual({ median: 2, p90: 4, total: 10 })
  })

  test('keeps unknown CI apart from a recorded zero', () => {
    const report = derive({
      landings: [
        landing('DEV-1', '2026-10-10T00:00:00Z', 11),
        landing('DEV-2', '2026-10-11T00:00:00Z', 12),
      ],
      runs: [run('DEV-1', '2026-10-09T00:00:00Z'), run('DEV-2', '2026-10-09T00:00:00Z')],
      ciRecords: [collection(11, true)],
    })

    expect(report.current.tasks.map((task) => task.ciRuns)).toEqual([0, null])
    expect(report.current.aggregates.ciRuns).toEqual({ median: 0, p90: 0, total: 0 })
    expect(report.current.aggregates.unknownCiTasks).toBe(1)
  })

  test('treats incomplete collection evidence as unknown even with stale attempts', () => {
    const report = derive({
      landings: [
        landing('DEV-1', '2026-10-10T00:00:00Z', 11),
        landing('DEV-2', '2026-10-11T00:00:00Z', 12),
        landing('DEV-3', '2026-10-12T00:00:00Z', 13),
      ],
      runs: [
        run('DEV-1', '2026-10-09T00:00:00Z'),
        run('DEV-2', '2026-10-09T00:00:00Z'),
        run('DEV-3', '2026-10-09T00:00:00Z'),
      ],
      ciRecords: [collection(11, false), collection(12, false), ci(12, 42), collection(13, true)],
    })

    expect(report.current.tasks.map((task) => task.ciRuns)).toEqual([null, null, 0])
    expect(report.current.aggregates.ciRuns).toEqual({ median: 0, p90: 0, total: 0 })
    expect(report.current.aggregates.unknownCiTasks).toBe(2)
  })

  test('counts later implementation and fix turns but excludes review lenses', () => {
    const report = derive({
      landings: [landing('DEV-1', '2026-10-10T00:00:00Z', 11)],
      runs: [
        run('DEV-1', '2026-10-09T00:00:00Z'),
        run('DEV-1', '2026-10-09T01:00:00Z', 2),
        run('DEV-1', '2026-10-09T02:00:00Z', 3, 'fix'),
        run('DEV-1', '2026-10-09T03:00:00Z', 2, 'review-lens'),
      ],
    })

    expect(report.current.tasks[0]?.fixTurns).toBe(2)
  })

  test('uses the earliest task run and latest task landing for dispatch to merge', () => {
    const report = derive({
      landings: [
        landing('DEV-1', '2026-10-10T12:00:00Z', 11, 'DEV-1-a'),
        landing('DEV-1', '2026-10-11T12:00:00Z', 12, 'DEV-1-b'),
      ],
      runs: [run('DEV-1', '2026-10-09T00:00:00Z'), run('DEV-1', '2026-10-10T00:00:00Z')],
    })

    expect(report.current.tasks[0]?.dispatchToMergeHours).toBe(60)
  })

  test('counts one reused review identity once and splits the previous window', () => {
    const report = derive({
      landings: [
        landing('DEV-OLD', '2026-10-07T12:00:00Z', 10),
        landing('dev-new', '2026-10-10T12:00:00Z', 11, 'DEV-NEW-a'),
        landing('dev-new', '2026-10-11T12:00:00Z', 12, 'DEV-NEW-b'),
      ],
      runs: [run('DEV-OLD', '2026-10-02T00:00:00Z'), run('dev-new', '2026-10-09T00:00:00Z')],
      reviewRounds: [
        { project: PLATFORM_NAME, taskKey: 'DEV-NEW', branch: 'DEV-NEW-a', identity: 'round-1' },
        { project: PLATFORM_NAME, taskKey: 'DEV-NEW', branch: 'DEV-NEW-b', identity: 'round-1' },
        { project: PLATFORM_NAME, taskKey: 'DEV-NEW', branch: 'DEV-NEW-b', identity: 'round-2' },
      ],
    })

    expect(report.current.aggregates.landedTasks).toBe(1)
    expect(report.current.tasks[0]?.reviewRounds).toBe(2)
    expect(report.previous.aggregates.landedTasks).toBe(1)
    expect(report.previous.tasks[0]?.taskKey).toBe('DEV-OLD')
  })

  test('keeps unattributed landings out of task metrics and reports them in their window', () => {
    const report = deriveCycleCost({
      currentWindow,
      previousWindow,
      landings: [],
      runs: [],
      reviewRounds: [],
      ciRecords: [],
      unattributedLandings: [
        {
          project: PLATFORM_NAME,
          branch: 'branch-without-a-task',
          pullRequestNumber: 17,
          mergedAt: '2026-10-10T00:00:00Z',
          reason: 'could not establish one task key; found none',
        },
      ],
    })

    expect(report.current.aggregates.landedTasks).toBe(0)
    expect(report.current.aggregates.unattributedLandings).toBe(1)
    expect(report.current.unattributedLandings).toEqual([
      {
        project: PLATFORM_NAME,
        branch: 'branch-without-a-task',
        pullRequestNumber: 17,
        reason: 'could not establish one task key; found none',
      },
    ])
    expect(report.previous.aggregates.unattributedLandings).toBe(0)
  })

  test('keeps a landed task without runs and excludes its unknown dispatch time', () => {
    const report = derive({
      landings: [landing('DEV-1', '2026-10-10T00:00:00Z', 11)],
      runs: [],
    })

    expect(report.current.aggregates.landedTasks).toBe(1)
    expect(report.current.aggregates.tasksWithoutRuns).toBe(1)
    expect(report.current.aggregates.fixTurns).toEqual({ median: 0, p90: 0, total: 0 })
    expect(report.current.aggregates.dispatchToMergeHours).toEqual({
      median: null,
      p90: null,
      total: null,
    })
    expect(report.current.tasks[0]?.dispatchToMergeHours).toBeNull()
  })
})
