// concern: cycle-cost evidence
/** Derives cycle cost per landed task and window from already-attributed plain evidence. */

import { attributedTaskKey } from '../epic/epic.ts'
import {
  derivePullRequestCiCounts,
  type PullRequestCiCountsInput,
} from '../pull-request/pr-ci-record.ts'
import { nearestRankPercentile } from '../state/statistics.ts'
import { utcMillis } from '../utc-millis.ts'

export type CycleCostLanding = {
  project: string
  taskKey: string
  branch: string
  pullRequestNumber: number
  mergedAt: string
}

export type CycleCostUnattributedLanding = {
  project: string
  branch: string
  pullRequestNumber: number
  mergedAt: string
  reason: string
}

export type CycleCostRun = {
  project: string
  taskKey: string
  job: string
  turn: number
  startedAt: string
}

export type CycleCostReviewRound = {
  project: string
  taskKey: string
  branch: string
  identity: string
}

export type CycleCostCiRecord = {
  project: string
  pullRequestNumber: number
  recordKind: 'collection' | 'attempt'
  complete: boolean | null
  workflowRunId: number | null
  runAttempt: number | null
  headCommit: string | null
  conclusion: string | null
}

export type CycleCostWindow = { start: string; end: string }

type CycleCostTask = {
  project: string
  taskKey: string
  branches: string[]
  pullRequestNumbers: number[]
  mergedAt: string
  reviewRounds: number
  fixTurns: number
  ciRuns: number | null
  reruns: number | null
  flakeAttributedReruns: number | null
  dispatchToMergeHours: number | null
}

export type CycleCostMetricAggregate = {
  median: number | null
  p90: number | null
  total: number | null
}

export type CycleCostWindowReport = {
  window: CycleCostWindow
  aggregates: {
    landedTasks: number
    reviewRounds: CycleCostMetricAggregate
    fixTurns: CycleCostMetricAggregate
    ciRuns: CycleCostMetricAggregate
    reruns: CycleCostMetricAggregate
    flakeAttributedReruns: CycleCostMetricAggregate
    dispatchToMergeHours: CycleCostMetricAggregate
    unknownCiTasks: number
    unattributedLandings: number
    tasksWithoutRuns: number
  }
  tasks: CycleCostTask[]
  unattributedLandings: Array<
    Pick<CycleCostUnattributedLanding, 'project' | 'branch' | 'pullRequestNumber' | 'reason'>
  >
}

export type CycleCostReport = {
  current: CycleCostWindowReport
  previous: CycleCostWindowReport
}

type CycleCostEvidence = {
  landings: readonly CycleCostLanding[]
  runs: readonly CycleCostRun[]
  reviewRounds: readonly CycleCostReviewRound[]
  ciRecords: readonly CycleCostCiRecord[]
  unattributedLandings: readonly CycleCostUnattributedLanding[]
}

const millis = (value: string): number => {
  const parsed = utcMillis(value)
  if (!Number.isFinite(parsed)) throw new Error(`invalid cycle-cost timestamp ${value}`)
  return parsed
}

const taskIdentity = (project: string, taskKey: string) => `${project}\0${taskKey}`

const aggregate = (values: readonly number[]): CycleCostMetricAggregate => ({
  median: nearestRankPercentile(values, 0.5),
  p90: nearestRankPercentile(values, 0.9),
  total: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
})

function ciCounts(pullRequestNumbers: readonly number[], records: readonly CycleCostCiRecord[]) {
  const completePullRequests = new Set(
    records.flatMap((record) =>
      record.recordKind === 'collection' && record.complete === true
        ? [record.pullRequestNumber]
        : [],
    ),
  )
  if (pullRequestNumbers.some((number) => !completePullRequests.has(number))) return null
  return derivePullRequestCiCounts(
    records.flatMap((record): PullRequestCiCountsInput[] =>
      record.recordKind === 'attempt' && record.workflowRunId !== null && record.runAttempt !== null
        ? [
            {
              workflowRunId: record.workflowRunId,
              runAttempt: record.runAttempt,
              headCommit: record.headCommit,
              conclusion: record.conclusion,
            },
          ]
        : [],
    ),
  )
}

function deriveTask(
  key: string,
  landings: readonly CycleCostLanding[],
  evidence: CycleCostEvidence,
): CycleCostTask {
  const first = landings[0]!
  const latestMerge = Math.max(...landings.map((landing) => millis(landing.mergedAt)))
  const taskRuns = evidence.runs.filter((run) => taskIdentity(run.project, run.taskKey) === key)
  const branches = [...new Set(landings.map((landing) => landing.branch))].sort()
  const branchSet = new Set(branches)
  const pullRequestNumbers = [
    ...new Set(landings.map((landing) => landing.pullRequestNumber)),
  ].sort((left, right) => left - right)
  const prSet = new Set(pullRequestNumbers)
  const ci = ciCounts(
    pullRequestNumbers,
    evidence.ciRecords.filter(
      (record) => record.project === first.project && prSet.has(record.pullRequestNumber),
    ),
  )
  const normalizedTaskKey = attributedTaskKey(first.taskKey, null)
  const reviewRounds = new Set(
    evidence.reviewRounds.flatMap((round) =>
      round.project === first.project &&
      round.taskKey === normalizedTaskKey &&
      branchSet.has(round.branch)
        ? [round.identity]
        : [],
    ),
  ).size
  return {
    project: first.project,
    taskKey: first.taskKey,
    branches,
    pullRequestNumbers,
    mergedAt: new Date(latestMerge).toISOString(),
    reviewRounds,
    fixTurns: taskRuns.filter(
      (run) => (run.job === 'implement' || run.job === 'fix') && run.turn > 1,
    ).length,
    ciRuns: ci?.ciRuns ?? null,
    reruns: ci?.reruns ?? null,
    flakeAttributedReruns: ci?.flakeAttributedReruns ?? null,
    dispatchToMergeHours: taskRuns.length
      ? (latestMerge - Math.min(...taskRuns.map((run) => millis(run.startedAt)))) / 3_600_000
      : null,
  }
}

function deriveWindow(window: CycleCostWindow, evidence: CycleCostEvidence): CycleCostWindowReport {
  const start = millis(window.start)
  const end = millis(window.end)
  if (start >= end) throw new Error('cycle-cost window start must be before its end')
  const taskLandings = new Map<string, CycleCostLanding[]>()
  for (const landing of evidence.landings) {
    const mergedAt = millis(landing.mergedAt)
    if (mergedAt < start || mergedAt >= end) continue
    const key = taskIdentity(landing.project, landing.taskKey)
    taskLandings.set(key, [...(taskLandings.get(key) ?? []), landing])
  }

  const tasks = [...taskLandings.entries()]
    .map(([key, landings]) => deriveTask(key, landings, evidence))
    .sort(
      (left, right) =>
        left.mergedAt.localeCompare(right.mergedAt) ||
        left.project.localeCompare(right.project) ||
        left.taskKey.localeCompare(right.taskKey),
    )

  const unattributedLandings = evidence.unattributedLandings.flatMap((landing) => {
    const mergedAt = millis(landing.mergedAt)
    return mergedAt >= start && mergedAt < end
      ? [
          {
            project: landing.project,
            branch: landing.branch,
            pullRequestNumber: landing.pullRequestNumber,
            reason: landing.reason,
          },
        ]
      : []
  })
  return {
    window,
    aggregates: {
      landedTasks: tasks.length,
      reviewRounds: aggregate(tasks.map((task) => task.reviewRounds)),
      fixTurns: aggregate(tasks.map((task) => task.fixTurns)),
      ciRuns: aggregate(tasks.flatMap((task) => (task.ciRuns === null ? [] : [task.ciRuns]))),
      reruns: aggregate(tasks.flatMap((task) => (task.reruns === null ? [] : [task.reruns]))),
      flakeAttributedReruns: aggregate(
        tasks.flatMap((task) =>
          task.flakeAttributedReruns === null ? [] : [task.flakeAttributedReruns],
        ),
      ),
      dispatchToMergeHours: aggregate(
        tasks.flatMap((task) =>
          task.dispatchToMergeHours === null ? [] : [task.dispatchToMergeHours],
        ),
      ),
      unknownCiTasks: tasks.filter((task) => task.ciRuns === null).length,
      unattributedLandings: unattributedLandings.length,
      tasksWithoutRuns: tasks.filter((task) => task.dispatchToMergeHours === null).length,
    },
    tasks,
    unattributedLandings,
  }
}

export function deriveCycleCost(input: {
  currentWindow: CycleCostWindow
  previousWindow: CycleCostWindow
  landings: readonly CycleCostLanding[]
  runs: readonly CycleCostRun[]
  reviewRounds: readonly CycleCostReviewRound[]
  ciRecords: readonly CycleCostCiRecord[]
  unattributedLandings?: readonly CycleCostUnattributedLanding[]
}): CycleCostReport {
  const evidence = {
    landings: input.landings,
    runs: input.runs,
    reviewRounds: input.reviewRounds,
    ciRecords: input.ciRecords,
    unattributedLandings: input.unattributedLandings ?? [],
  }
  return {
    current: deriveWindow(input.currentWindow, evidence),
    previous: deriveWindow(input.previousWindow, evidence),
  }
}
