import { describe, expect, test } from 'bun:test'
import { decideTaskStageSelection, taskFlowState } from './task-flow-decision.ts'

describe('task flow state projection', () => {
  test.each([
    ['done', 'done'],
    ['dropped', 'dropped'],
    ['cancelled', 'dropped'],
    ['active', 'open'],
    [null, null],
    [undefined, null],
  ] as const)('%s maps to %s', (status, state) => expect(taskFlowState(status)).toBe(state))
})

test('a task with no open stage may enter any workflow, including an earlier one', () => {
  expect(decideTaskStageSelection(null, { workflow: 'plan-task', mode: 'default' })).toEqual({
    action: 'open',
  })
})

test('the open stage is reused and a different stage is refused by cursor or workflow', () => {
  const stage = { cursor: 42, workflow: 'plan-task', mode: 'default' }
  expect(decideTaskStageSelection(stage, { workflow: 'plan-task', mode: 'default' }).action).toBe(
    'reuse',
  )
  expect(
    decideTaskStageSelection(stage, { cursor: 42, workflow: 'ship-task', mode: 'default' }).action,
  ).toBe('reuse')
  expect(decideTaskStageSelection(stage, { workflow: 'ship-task', mode: 'default' })).toEqual({
    action: 'refuse',
    stage,
  })
})
