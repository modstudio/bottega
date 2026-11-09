// concern: session close-out obligations
/** Pure process items for judgments and tracker work a closing session still owes. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  type BranchLandingTaskRow,
  resolveBranchLandingTaskKey,
} from '../branch/branch-landing-records.ts'
import type { LandedTaskObservation } from '../branch/task-status-observation.ts'
import {
  decideUnjudgedRunRemedy,
  renderUnjudgedRunRemedy,
} from '../evidence/unjudged-run-remedy.ts'
import { taskFlowState } from '../workflow/task-flow-decision.ts'
import type { SessionProcessLine } from './session-close-out-report.ts'

export type PendingScoreRoot = {
  record_id: string
  agent: string
  job: string
  prompt_head: string
  status: string
  failure_kind: string | null
}

export type LandedTaskIdentity = { project: string; taskKey: string }

/** Select the union of landings owned through a run or recorded by the session. */
export function landedTaskIdentities(input: {
  session: string
  ownedRunRecordIds: ReadonlySet<string>
  rows: readonly BranchLandingTaskRow[]
  keyPrefixesByProject: ReadonlyMap<string, readonly string[]>
}): LandedTaskIdentity[] {
  const tasks = new Map<string, LandedTaskIdentity>()
  for (const row of input.rows) {
    const ownedThroughRun = row.runRecordId !== null && input.ownedRunRecordIds.has(row.runRecordId)
    if (!ownedThroughRun && row.recordingSession !== input.session) continue
    const taskKey = resolveBranchLandingTaskKey(
      row,
      input.keyPrefixesByProject.get(row.project) ?? [],
    )
    if (!taskKey) continue
    tasks.set(`${row.project}\0${taskKey}`, {
      project: row.project,
      taskKey,
    })
  }
  return [...tasks.values()]
}

function pendingScoreItem(row: PendingScoreRoot): SessionProcessLine {
  const remedy = decideUnjudgedRunRemedy(row.failure_kind, row.agent)
  return {
    item: `unscored run ${row.record_id}`,
    reason: `${row.agent}/${row.job} has no current score`,
    evidence: row.prompt_head,
    remedy: renderUnjudgedRunRemedy(remedy, row.record_id),
  }
}

function landedTaskItem(task: LandedTaskObservation): SessionProcessLine | null {
  if (task.observation.verified && taskFlowState(task.observation.category) !== 'open') return null
  return {
    item: `landed task ${task.project}:${task.taskKey}`,
    reason: task.observation.verified
      ? `task is ${task.observation.category}`
      : 'task status could not be verified',
    evidence: task.observation.detail,
    remedy: `${PLATFORM_SLUG} task set ${task.taskKey} --project ${task.project} --status done`,
  }
}

/** Convert outstanding score and landed-task obligations to the shared close-out report shape. */
export function sessionCloseOutObligations(input: {
  pendingScores: readonly PendingScoreRoot[]
  landedTasks: readonly LandedTaskObservation[]
}): SessionProcessLine[] {
  const process = input.pendingScores.map(pendingScoreItem)
  for (const task of input.landedTasks) {
    const item = landedTaskItem(task)
    if (item) process.push(item)
  }
  return process
}
