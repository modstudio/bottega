// concern: cleanup sweep task context
/** Decides which task context holders are safe to clear from one complete hub read. */

import type { HubTaskReference } from '../workflow/workflow-task-reference.ts'

export type TaskContextHolderFacts = {
  holderId: string
  itemCount: number
}

type TaskContextHolderToClear = TaskContextHolderFacts & {
  key: string
  project: string
}

export type TaskContextReapDecision = {
  clear: TaskContextHolderToClear[]
  keptOpen: number
  unresolved: TaskContextHolderFacts[]
}

export function decideTaskContextReap(
  holders: readonly TaskContextHolderFacts[],
  tasks: readonly Pick<HubTaskReference, 'record_id' | 'key' | 'project' | 'status_category'>[],
): TaskContextReapDecision {
  const tasksById = new Map(tasks.map((task) => [task.record_id, task]))
  const decision: TaskContextReapDecision = { clear: [], keptOpen: 0, unresolved: [] }
  for (const holder of holders) {
    const task = tasksById.get(holder.holderId)
    if (!task) {
      decision.unresolved.push(holder)
    } else if (task.status_category === 'done') {
      decision.clear.push({ ...holder, key: task.key, project: task.project })
    } else {
      decision.keptOpen++
    }
  }
  return decision
}
