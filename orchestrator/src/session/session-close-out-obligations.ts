// concern: session close-out obligations
/** Pure process items for judgments and tracker work a closing session still owes. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { StatusCategory } from '../../../shared/trackers.ts'
import {
  decideUnjudgedRunRemedy,
  renderUnjudgedRunRemedy,
} from '../evidence/unjudged-run-remedy.ts'
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

export type LandedTaskRow = {
  project: string
  branch: string
  recordingSession: string | null
  runRecordId: string | null
  taskKey: string | null
}

export type LandedTaskObservation = LandedTaskIdentity & {
  observation: {
    category: StatusCategory | null
    verified: boolean
    detail: string
  }
}

/** Select the union of landings owned through a run or recorded by the session. */
export function landedTaskIdentities(input: {
  session: string
  ownedRunRecordIds: ReadonlySet<string>
  rows: readonly LandedTaskRow[]
}): LandedTaskIdentity[] {
  const tasks = new Map<string, LandedTaskIdentity>()
  for (const row of input.rows) {
    const ownedThroughRun = row.runRecordId !== null && input.ownedRunRecordIds.has(row.runRecordId)
    if ((!ownedThroughRun && row.recordingSession !== input.session) || !row.taskKey) continue
    tasks.set(`${row.project}\0${row.taskKey}`, {
      project: row.project,
      taskKey: row.taskKey,
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
  if (
    task.observation.verified &&
    (task.observation.category === 'done' || task.observation.category === 'dropped')
  )
    return null
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
  const seen = new Set<string>()
  for (const task of input.landedTasks) {
    const identity = `${task.project}\0${task.taskKey}`
    if (seen.has(identity)) continue
    seen.add(identity)
    const item = landedTaskItem(task)
    if (item) process.push(item)
  }
  return process
}
