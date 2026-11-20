import { expect, test } from 'bun:test'
import { descendantTaskFacts, selectEpicStartFloors } from './workflow-epic-floor.ts'
import { decideFloorSatisfaction, type Floor } from './workflow-floor.ts'

const floor = (kind: Floor['kind']): Floor => ({
  kind,
  deferrable: true,
  expectedExitCode: 0,
  expectedStatus: 'done',
  requirePullRequest: false,
  operatorRuling: false,
})

test('selects one start floor from whether the task is an epic', () => {
  const floors = [
    floor('tracker-transition'),
    floor('recorded-artifact'),
    floor('descendants-closed'),
  ]
  expect(
    selectEpicStartFloors(floors, {
      workflow: 'plan-task',
      step: 'start',
      hasChildren: true,
    }).map(({ kind }) => kind),
  ).toEqual(['recorded-artifact', 'descendants-closed'])
  expect(
    selectEpicStartFloors(floors, {
      workflow: 'plan-task',
      step: 'start',
      hasChildren: false,
    }).map(({ kind }) => kind),
  ).toEqual(['tracker-transition', 'recorded-artifact'])
})

test('finds unfinished descendants recursively', () => {
  const rows = [
    { key: 'DEV-2', parentKey: 'DEV-1', status: 'Done', statusCategory: 'done' },
    { key: 'DEV-3', parentKey: 'DEV-2', status: 'Active', statusCategory: 'active' },
  ]
  expect(descendantTaskFacts('DEV-1', rows).map(({ key }) => key)).toEqual(['DEV-2', 'DEV-3'])
})

test('descendants-closed names unfinished work and accepts done or dropped descendants', () => {
  const epicFloor = floor('descendants-closed')
  const base = {
    floors: [epicFloor],
    enforcement: 'floors' as const,
    finishing: true,
    openObligations: [],
    evidence: {
      task: {
        key: 'DEV-1',
        status: 'Done',
        statusCategory: 'done',
        mergedPullRequest: null,
        trackerStates: { Done: 'done' as const },
      },
    },
  }
  expect(
    decideFloorSatisfaction({
      ...base,
      evidence: {
        ...base.evidence,
        descendants: [{ key: 'DEV-2', status: 'Active', statusCategory: 'active' }],
      },
    }),
  ).toEqual({
    action: 'refuse',
    message:
      'floor descendants-closed is unmet; unfinished descendants: DEV-2 (Active); finish or drop them, move the epic to done, then pass --task <KEY>',
  })
  expect(
    decideFloorSatisfaction({
      ...base,
      evidence: {
        ...base.evidence,
        descendants: [
          { key: 'DEV-2', status: 'Done', statusCategory: 'done' },
          { key: 'DEV-3', status: 'Dropped', statusCategory: 'dropped' },
        ],
      },
    }).action,
  ).toBe('allow')
  expect(
    decideFloorSatisfaction({
      ...base,
      evidence: {
        task: { ...base.evidence.task, status: 'Active', statusCategory: 'active' },
        descendants: [{ key: 'DEV-2', status: 'Done', statusCategory: 'done' }],
      },
    }).action,
  ).toBe('refuse')
})
