// concern: workflow epic floor
/** Purely selects the start floor and classifies recursive descendant completion. */

import type { Floor, FloorKind } from './workflow-floor.ts'

export type EpicTaskFact = {
  key: string
  parentKey: string | null
  status: string | null
  statusCategory: string | null
}

export function descendantTaskFacts(rootKey: string, tasks: readonly EpicTaskFact[]): EpicTaskFact[] {
  const children = new Map<string, EpicTaskFact[]>()
  for (const task of tasks) {
    if (!task.parentKey) continue
    children.set(task.parentKey, [...(children.get(task.parentKey) ?? []), task])
  }
  const descendants: EpicTaskFact[] = []
  const visit = (key: string) => {
    for (const child of children.get(key) ?? []) {
      descendants.push(child)
      visit(child.key)
    }
  }
  visit(rootKey)
  return descendants
}

export function selectEpicStartFloors(
  floors: readonly Floor[],
  input: { workflow: string; step: string; hasChildren: boolean },
): Floor[] {
  if (input.workflow !== 'plan-task' || input.step !== 'start') return [...floors]
  const selected: FloorKind = input.hasChildren ? 'descendants-closed' : 'tracker-transition'
  return floors.filter(({ kind }) => kind === selected)
}

export const unfinishedDescendants = (tasks: readonly EpicTaskFact[]): EpicTaskFact[] =>
  tasks.filter((task) => task.statusCategory !== 'done' && task.statusCategory !== 'dropped')
