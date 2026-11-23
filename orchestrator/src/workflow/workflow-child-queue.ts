// concern: workflow child queue
/** Pure queue/Open classification and child selection. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { workflowCursorReference } from './workflow-cursor-format.ts'
import { descendantTaskKeys } from './workflow-task-tree.ts'

export type ChildTaskFact = {
  key: string
  project: string
  parentKey: string | null
  number: number
  statusCategory: string | null
  hasChildren?: boolean
  cursorEverComposed: boolean
  cursorNumber: number | null
  cursorState: string | null
  liveTaskClaimSession: string | null
  liveQueuedClaimSession: string | null
  queuedAt: string | null
}

export type ChildQueueState = {
  queue: ChildTaskFact[]
  open: ChildTaskFact[]
  descendantKeys: ReadonlySet<string>
}

export type ChildClaimFact = {
  subject_kind: string
  subject_value: string
  holderUserId: string | null
  holderSession: string | null
}

export function sessionWorksUnderEpic(
  claims: readonly ChildClaimFact[],
  session: string,
  rootKey: string,
  descendants: ReadonlySet<string>,
): boolean {
  return claims.some(
    (claim) =>
      claim.holderSession === session &&
      ((claim.subject_kind === 'task' && claim.subject_value === rootKey) ||
        (claim.subject_kind === 'queued-task' && descendants.has(claim.subject_value))),
  )
}

export type ChildEligibility =
  | { action: 'eligible'; task: ChildTaskFact; source: 'queue' | 'open' }
  | { action: 'refuse'; message: string }

export function childEligibility(
  state: ChildQueueState,
  tasks: readonly ChildTaskFact[],
  requested: string,
): ChildEligibility {
  const queued = state.queue.find(({ key }) => key === requested)
  if (queued) return { action: 'eligible', task: queued, source: 'queue' }
  const open = state.open.find(({ key }) => key === requested)
  if (open) return { action: 'eligible', task: open, source: 'open' }
  const task = tasks.find(({ key }) => key === requested)
  if (task?.liveTaskClaimSession)
    return {
      action: 'refuse',
      message: `${requested} is claimed by session ${task.liveTaskClaimSession}`,
    }
  if (task?.liveQueuedClaimSession)
    return {
      action: 'refuse',
      message: `${requested} is queued for session ${task.liveQueuedClaimSession}`,
    }
  if (
    task?.cursorEverComposed &&
    task.cursorNumber !== null &&
    task.cursorState !== null &&
    state.descendantKeys.has(requested)
  )
    return {
      action: 'refuse',
      message: `${requested} already has a plan-task cursor ${task.cursorNumber} (${task.cursorState}); finish it, or abandon it with ${PLATFORM_SLUG} workflow abandon${workflowCursorReference(task.cursorNumber, task.project).cli}, before queuing it again`,
    }
  return { action: 'refuse', message: `${requested} is not queueable under this epic` }
}

export function childQueueState(
  rootKey: string,
  session: string,
  tasks: readonly ChildTaskFact[],
): ChildQueueState {
  const childCount = new Map<string, number>()
  for (const task of tasks)
    if (task.parentKey) childCount.set(task.parentKey, (childCount.get(task.parentKey) ?? 0) + 1)
  const descendants = descendantTaskKeys(rootKey, tasks)
  const queueable = tasks.filter(
    (task) =>
      descendants.has(task.key) &&
      !(task.hasChildren ?? childCount.has(task.key)) &&
      task.statusCategory !== 'done' &&
      task.statusCategory !== 'dropped' &&
      !task.cursorEverComposed &&
      task.liveTaskClaimSession === null,
  )
  return {
    descendantKeys: descendants,
    queue: queueable
      .filter((task) => task.liveQueuedClaimSession === session)
      .sort(
        (left, right) =>
          (left.queuedAt ?? '').localeCompare(right.queuedAt ?? '') || left.number - right.number,
      ),
    open: queueable
      .filter((task) => task.liveQueuedClaimSession === null)
      .sort((left, right) => left.number - right.number),
  }
}

export function selectChildToStart(
  state: ChildQueueState,
  tasks: readonly ChildTaskFact[],
  requested?: string,
): { action: 'start'; task: ChildTaskFact } | { action: 'refuse'; message: string } {
  if (requested) {
    const decision = childEligibility(state, tasks, requested)
    return decision.action === 'eligible' ? { action: 'start', task: decision.task } : decision
  }
  const task = state.queue[0] ?? state.open[0]
  return task
    ? { action: 'start', task }
    : { action: 'refuse', message: 'nothing is queued or open under the epic' }
}
