import { describe, expect, test } from 'bun:test'
import {
  decideTaskFlowReadStatus,
  decideTaskFlowReadThrough,
  decideTaskStageSelection,
  decideWorkflowTakeover,
  taskFlowState,
} from './task-flow-decision.ts'

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

test('takeover decision distinguishes same-machine, reachable, and offline advances', () => {
  expect(
    decideWorkflowTakeover({
      currentMachineId: 'machine-a',
      holderMachineId: 'machine-a',
      recordRead: 'unreachable',
    }),
  ).toEqual({ action: 'same-machine' })
  expect(
    decideWorkflowTakeover({
      currentMachineId: 'machine-b',
      holderMachineId: 'machine-a',
      recordRead: 'reachable',
    }),
  ).toEqual({ action: 'take-over', fromMachineId: 'machine-a' })
  expect(
    decideWorkflowTakeover({
      currentMachineId: 'machine-b',
      holderMachineId: 'machine-a',
      recordRead: 'unreachable',
      recordRemedy: 'sign in',
    }),
  ).toEqual({ action: 'refuse', fromMachineId: 'machine-a', remedy: 'sign in' })
  expect(
    decideWorkflowTakeover({
      currentMachineId: 'machine-b',
      holderMachineId: 'machine-a',
      recordRead: 'not-attempted',
      workflowKey: 'DEV-2098',
    }),
  ).toEqual({
    action: 'refuse',
    fromMachineId: 'machine-a',
    remedy:
      'the stage was last advanced by this holder and was not read from the record; re-run with --key DEV-2098',
  })
})

test('read-through picks local, hosted, or refresh from stage revisions', () => {
  expect(
    decideTaskFlowReadThrough({
      localFlowExists: false,
      localStageRevision: null,
      hostedStageRevision: null,
    }),
  ).toBe('hosted')
  expect(
    decideTaskFlowReadThrough({
      localFlowExists: true,
      localStageRevision: 4,
      hostedStageRevision: null,
    }),
  ).toBe('local')
  expect(
    decideTaskFlowReadThrough({
      localFlowExists: true,
      localStageRevision: null,
      hostedStageRevision: 1,
    }),
  ).toBe('hosted')
  expect(
    decideTaskFlowReadThrough({
      localFlowExists: true,
      localStageRevision: 4,
      hostedStageRevision: 5,
    }),
  ).toBe('refresh')
  expect(
    decideTaskFlowReadThrough({
      localFlowExists: true,
      localStageRevision: 5,
      hostedStageRevision: 5,
    }),
  ).toBe('local')
})

test('task-flow route compatibility recognizes only its named not-found', () => {
  expect(
    decideTaskFlowReadStatus({
      status: 404,
      recognizedNotFound: true,
      configured: true,
      errorRemedy: 'not found',
    }),
  ).toEqual({ status: 'reachable' })
  for (const status of [404, 405])
    expect(
      decideTaskFlowReadStatus({
        status,
        recognizedNotFound: false,
        configured: true,
        errorRemedy: 'route missing',
      }),
    ).toEqual({
      status: 'unreachable',
      remedy: 'record API predates task-flow read; release hosted-api, then retry',
    })
})
