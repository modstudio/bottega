// concern: workflow epic floor
/** Purely selects the start floor and classifies recursive descendant completion. */

import type { Floor, FloorKind } from './workflow-floor.ts'
import { descendantTaskKeys } from './workflow-task-tree.ts'

export type EpicTaskFact = {
  key: string
  parentKey: string | null
  status: string | null
  statusCategory: string | null
}

export function descendantTaskFacts(
  rootKey: string,
  tasks: readonly EpicTaskFact[],
): EpicTaskFact[] {
  const descendants = descendantTaskKeys(rootKey, tasks)
  return tasks.filter(({ key }) => descendants.has(key))
}

export function selectEpicStartFloors(
  floors: readonly Floor[],
  input: { workflow: string; step: string; hasChildren: boolean },
): Floor[] {
  if (input.workflow !== 'plan-task' || input.step !== 'start') return [...floors]
  const selected: FloorKind = input.hasChildren ? 'descendants-closed' : 'tracker-transition'
  return floors.filter(({ kind }) => kind === selected)
}
