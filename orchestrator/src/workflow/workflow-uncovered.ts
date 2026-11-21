// concern: workflow-uncovered
/** Measures task work without keyed coverage and taskless jobs without any cursor binding. */

import type { Database } from 'bun:sqlite'
import { boardClaimList } from '../board/board-operations.ts'
import { decideLandingTaskKey } from '../branch/branch-landing-service.ts'
import { db } from '../database/db.ts'
import { projectByName, projects } from '../project/projects.ts'
import { isClosedStageState } from '../record/record-task-flow-contract.ts'
import {
  type CursorlessRunEvidence,
  cursorlessRunEvidence,
  type FailedBeforeClaimRunEvidence,
  failedBeforeClaimRunEvidence,
} from '../run/cursorless-run-evidence.ts'
import { type TaskFlowReadStore, taskFlowReadStore } from './task-flow-store.ts'

const WORKFLOW_UNCOVERED_DEFAULT_DAYS = 14

export type KeyedWorkEvidence = {
  project: string
  key: string
  at: string
  source: 'run' | 'landing'
}

export type TaskCoverage = {
  project: string
  key: string
  openedAt: string
  closedAt: string | null
}
export type HandoffTransition = {
  project: string
  key: string
  closedAt: string
  openedAt: string
}

export type WorkflowUncoveredReport = {
  expected: 0
  days: Array<{
    day: string
    count: number
    tasks: Array<{ project: string; key: string }>
    cursorlessRuns: Array<{ number: number; job: string; session: string | null }>
    probeRuns: Array<{ number: number; job: string; session: string | null }>
    failedBeforeClaim: number
  }>
}

const covers = (coverage: TaskCoverage, evidence: KeyedWorkEvidence): boolean =>
  coverage.project === evidence.project &&
  coverage.key === evidence.key &&
  coverage.openedAt <= evidence.at &&
  (coverage.closedAt === null || evidence.at < coverage.closedAt)

export function decideWorkflowUncovered(input: {
  days: number
  now: string
  evidence: readonly KeyedWorkEvidence[]
  cursors: readonly TaskCoverage[]
  claims: readonly TaskCoverage[]
  handoffs?: readonly HandoffTransition[]
  cursorlessRuns?: readonly CursorlessRunEvidence[]
  failedBeforeClaimRuns?: readonly FailedBeforeClaimRunEvidence[]
}): WorkflowUncoveredReport {
  if (!Number.isSafeInteger(input.days) || input.days < 1)
    throw new Error('--days must be a positive integer')
  const today = new Date(input.now)
  if (!Number.isFinite(today.getTime()))
    throw new Error('workflow uncovered requires a valid clock')
  const dayNames = Array.from({ length: input.days }, (_, offset) => {
    const day = new Date(today)
    day.setUTCDate(day.getUTCDate() - offset)
    return day.toISOString().slice(0, 10)
  }).reverse()
  const wanted = new Set(dayNames)
  const uncovered = input.evidence.filter(
    (item) =>
      wanted.has(item.at.slice(0, 10)) &&
      !input.cursors.some((coverage) => covers(coverage, item)) &&
      !input.claims.some((coverage) => covers(coverage, item)),
  )
  const handoffGaps = (input.handoffs ?? []).filter(
    (handoff) =>
      wanted.has(handoff.openedAt.slice(0, 10)) &&
      !input.claims.some(
        (claim) =>
          claim.project === handoff.project &&
          claim.key === handoff.key &&
          claim.openedAt <= handoff.closedAt &&
          (claim.closedAt === null || handoff.openedAt < claim.closedAt),
      ),
  )
  return {
    expected: 0,
    days: dayNames.map((day) => {
      const unique = new Map<string, { project: string; key: string }>()
      for (const item of uncovered) {
        if (item.at.slice(0, 10) !== day) continue
        unique.set(`${item.project}\0${item.key}`, { project: item.project, key: item.key })
      }
      for (const item of handoffGaps) {
        if (item.openedAt.slice(0, 10) !== day) continue
        unique.set(`${item.project}\0${item.key}`, { project: item.project, key: item.key })
      }
      const tasks = [...unique.values()].sort(
        (left, right) =>
          left.project.localeCompare(right.project) || left.key.localeCompare(right.key),
      )
      const cursorlessRuns = (input.cursorlessRuns ?? [])
        .filter((run) => run.at.slice(0, 10) === day && !run.probe)
        .map(({ number, job, session }) => ({ number, job, session }))
        .sort((left, right) => left.number - right.number)
      const probeRuns = (input.cursorlessRuns ?? [])
        .filter((run) => run.at.slice(0, 10) === day && run.probe)
        .map(({ number, job, session }) => ({ number, job, session }))
        .sort((left, right) => left.number - right.number)
      const failedBeforeClaim =
        input.failedBeforeClaimRuns?.find((evidence) => evidence.day === day)?.count ?? 0
      return { day, count: tasks.length, tasks, cursorlessRuns, probeRuns, failedBeforeClaim }
    }),
  }
}

type LandingEvidenceRow = {
  project: string
  branch: string
  mergedAt: string
  launchKey: string | null
}

function readLandingEvidence(database: Database, from: string): KeyedWorkEvidence[] {
  const rows = database
    .query<LandingEvidenceRow, [string]>(
      `SELECT landing.project,landing.branch,landing.merged_at mergedAt,run.launch_key launchKey
         FROM branch_landing_record landing
         LEFT JOIN run
           ON run.project_record_id=landing.project_record_id
          AND (run.branch=landing.branch OR run.minted_branch=landing.branch)
        WHERE landing.merged_at>=?
        ORDER BY landing.project,landing.branch,run.launch_key`,
    )
    .all(from)
  const grouped = new Map<string, LandingEvidenceRow[]>()
  for (const row of rows) {
    const id = `${row.project}\0${row.branch}\0${row.mergedAt}`
    grouped.set(id, [...(grouped.get(id) ?? []), row])
  }
  const evidence: KeyedWorkEvidence[] = []
  for (const group of grouped.values()) {
    const first = group[0]!
    const project = projectByName(first.project, database)
    if (!project) continue
    const decision = decideLandingTaskKey(
      group.flatMap((row) => (row.launchKey ? [row.launchKey] : [])),
      first.branch,
      project.settings.keyPrefixes ?? [],
    )
    if (decision.attributed)
      evidence.push({
        project: first.project,
        key: decision.taskKey,
        at: first.mergedAt,
        source: 'landing',
      })
  }
  return evidence
}

type WorkflowUncoveredDependencies = {
  taskFlowStore?: Pick<TaskFlowReadStore, 'keyedStageHistory'>
  claimList?: typeof boardClaimList
}

export async function workflowUncoveredReport(
  input: { days?: number; database?: Database; clock?: number } = {},
  dependencies: WorkflowUncoveredDependencies = {},
): Promise<WorkflowUncoveredReport> {
  const days = input.days ?? WORKFLOW_UNCOVERED_DEFAULT_DAYS
  if (!Number.isSafeInteger(days) || days < 1) throw new Error('--days must be a positive integer')
  const database = input.database ?? db()
  const now = new Date(input.clock ?? Date.now())
  const firstDay = new Date(now)
  firstDay.setUTCHours(0, 0, 0, 0)
  firstDay.setUTCDate(firstDay.getUTCDate() - days + 1)
  const from = firstDay.toISOString()
  const runs = database
    .query<{ project: string; key: string; at: string }, [string]>(
      `SELECT project.name project,run.launch_key key,run.started_at at
         FROM run JOIN project ON project.record_id=run.project_record_id
        WHERE run.launch_key IS NOT NULL AND run.started_at>=?`,
    )
    .all(from)
    .map((row) => ({ ...row, source: 'run' as const }))
  const cursorlessRuns = cursorlessRunEvidence(database, from)
  const failedBeforeClaimRuns = failedBeforeClaimRunEvidence(database, from)
  let cursorRows: Awaited<ReturnType<TaskFlowReadStore['keyedStageHistory']>>
  try {
    cursorRows = await (
      dependencies.taskFlowStore ?? taskFlowReadStore(database)
    ).keyedStageHistory({
      since: from,
    })
  } catch (error) {
    throw new Error(
      `workflow uncovered could not read task-flow cursor coverage: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  const cursors = cursorRows.map((row) => ({
    project: row.project,
    key: row.workflow_key,
    openedAt: row.created_at,
    closedAt: isClosedStageState(row.state) ? row.updated_at : null,
  }))
  const byRecordId = new Map(cursorRows.map((row) => [row.record_id, row]))
  const handoffs = cursorRows.flatMap((row): HandoffTransition[] => {
    const previous = row.handed_off_from_record_id
      ? byRecordId.get(row.handed_off_from_record_id)
      : undefined
    return previous
      ? [
          {
            project: row.project,
            key: row.workflow_key,
            closedAt: previous.updated_at,
            openedAt: row.created_at,
          },
        ]
      : []
  })
  const claimList = dependencies.claimList ?? boardClaimList
  const claims: TaskCoverage[] = []
  for (const project of projects(undefined, database)) {
    let listed: Awaited<ReturnType<typeof boardClaimList>>
    try {
      listed = await claimList(project.name, true, {
        database,
        taskCursorAuthority: { mode: 'coverage-read', session: null },
      })
    } catch (error) {
      throw new Error(
        `workflow uncovered could not read board claim coverage for project ${project.name}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    claims.push(
      ...listed.claims
        .filter((claim) => claim.subject.kind === 'task')
        .map((claim) => ({
          project: claim.project,
          key: claim.subject.value,
          openedAt: claim.takenAt,
          closedAt:
            claim.closedAt && claim.closedAt < claim.lapsesAt ? claim.closedAt : claim.lapsesAt,
        })),
    )
  }
  return decideWorkflowUncovered({
    days,
    now: now.toISOString(),
    evidence: [...runs, ...readLandingEvidence(database, from)],
    cursors,
    claims,
    handoffs,
    cursorlessRuns,
    failedBeforeClaimRuns,
  })
}

export function workflowUncoveredCommand(
  options: { days?: string; json?: boolean },
  output: { log(value: string): void; setExitCode(code: number): void },
  report: typeof workflowUncoveredReport = workflowUncoveredReport,
): Promise<void> {
  const days = options.days === undefined ? undefined : Number(options.days)
  return report({ ...(days === undefined ? {} : { days }) }).then((result) => {
    if (options.json) {
      output.log(JSON.stringify(result, null, 2))
    } else {
      for (const row of result.days) {
        const keys = row.tasks.map((task) => `${task.project}/${task.key}`).join(', ')
        output.log(
          `${row.day}: ${row.count} (expected ${result.expected})${keys ? `  ${keys}` : ''}`,
        )
        const runs = row.cursorlessRuns.map((run) => `#${run.number} ${run.job}`).join(', ')
        output.log(
          `  cursorless runs: ${row.cursorlessRuns.length} (expected ${result.expected})${runs ? `  ${runs}` : ''}`,
        )
        const probeRuns = row.probeRuns.map((run) => `#${run.number} ${run.job}`).join(', ')
        output.log(`  probe runs: ${row.probeRuns.length}${probeRuns ? `  ${probeRuns}` : ''}`)
        output.log(`  failed before claim: ${row.failedBeforeClaim}`)
      }
    }
    output.setExitCode(
      result.days.some(
        (row) => row.count > result.expected || row.cursorlessRuns.length > result.expected,
      )
        ? 1
        : 0,
    )
  })
}
