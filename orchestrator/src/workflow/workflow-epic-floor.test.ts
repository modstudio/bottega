import { expect, test } from 'bun:test'
import { descendantTaskFacts, selectEpicStartFloors } from './workflow-epic-floor.ts'
import type { Floor } from './workflow-floor.ts'

const floor = (kind: Floor['kind']): Floor => ({
  kind,
  deferrable: true,
  expectedExitCode: 0,
  expectedStatus: 'done',
  requirePullRequest: false,
  operatorRuling: false,
})

test('selects one start floor from whether the task is an epic', () => {
  const floors = [floor('tracker-transition'), floor('descendants-closed')]
  expect(
    selectEpicStartFloors(floors, {
      workflow: 'plan-task',
      step: 'start',
      hasChildren: true,
    }).map(({ kind }) => kind),
  ).toEqual(['descendants-closed'])
  expect(
    selectEpicStartFloors(floors, {
      workflow: 'plan-task',
      step: 'start',
      hasChildren: false,
    }).map(({ kind }) => kind),
  ).toEqual(['tracker-transition'])
})

test('finds unfinished descendants recursively', () => {
  const rows = [
    { key: 'DEV-2', parentKey: 'DEV-1', status: 'Done', statusCategory: 'done' },
    { key: 'DEV-3', parentKey: 'DEV-2', status: 'Active', statusCategory: 'active' },
  ]
  expect(descendantTaskFacts('DEV-1', rows).map(({ key }) => key)).toEqual(['DEV-2', 'DEV-3'])
})
