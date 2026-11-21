import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { Floor, FloorKind } from './workflow-floor.ts'
import {
  decideWorkflowRepin,
  type RepinClosedStep,
  type RepinStep,
} from './workflow-repin-decision.ts'

const floor = (kind: FloorKind, overrides: Partial<Floor> = {}): Floor => ({
  kind,
  deferrable: false,
  expectedExitCode: 0,
  expectedStatus: 'done',
  requirePullRequest: false,
  operatorRuling: false,
  ...overrides,
})

const closedSteps: RepinClosedStep[] = [
  {
    ordinal: 1,
    slug: 'plan',
    oldFloors: [floor('recorded-artifact')],
    newFloors: [floor('recorded-artifact')],
  },
]
const oldSteps: RepinStep[] = [{ slug: 'plan' }, { slug: 'close-task' }, { slug: 'later' }]
const input = {
  cursor: 1206,
  oldSteps,
  newSteps: oldSteps,
  currentOrdinal: 1,
  closedSteps,
  holderSession: 'session-one',
  callerSession: 'session-one',
  callerIsOperator: false,
  pendingQuestion: false,
  pendingAwait: false,
  alreadyCurrent: false,
  retryCommand: `${PLATFORM_SLUG} workflow repin --cursor 1206 --project fixture --reason <text>`,
}

test('repin refuses a differing slug through the current ordinal', () => {
  expect(
    decideWorkflowRepin({
      ...input,
      newSteps: [oldSteps[0]!, { ...oldSteps[1]!, slug: 'other-close' }, oldSteps[2]!],
    }),
  ).toMatchObject({ action: 'refuse', message: expect.stringContaining('step 2 differs') })
})

test('repin refuses a floor added to an already-closed step', () => {
  expect(
    decideWorkflowRepin({
      ...input,
      newSteps: [oldSteps[0]!, oldSteps[1]!, oldSteps[2]!],
      closedSteps: [
        {
          ...closedSteps[0]!,
          newFloors: [floor('recorded-artifact'), floor('ruling')],
        },
      ],
    }),
  ).toMatchObject({ action: 'refuse', message: expect.stringContaining('floor ruling added') })
})

test('repin allows current-step floor changes and later-step changes', () => {
  expect(
    decideWorkflowRepin({
      ...input,
      newSteps: [oldSteps[0]!, oldSteps[1]!, { slug: 'replacement' }],
    }),
  ).toEqual({ action: 'allow' })
})

test('repin refuses an outcome floor added to a closed step', () => {
  expect(
    decideWorkflowRepin({
      ...input,
      closedSteps: [
        {
          ordinal: 1,
          slug: 'plan',
          outcome: 'accepted',
          oldFloors: [floor('recorded-artifact')],
          newFloors: [floor('recorded-artifact'), floor('ruling')],
        },
      ],
    }),
  ).toMatchObject({
    action: 'refuse',
    message: expect.stringContaining('step 1 plan outcome accepted floor ruling added'),
  })
})

test('repin refuses a changed attribute on a floor of an already-closed step', () => {
  expect(
    decideWorkflowRepin({
      ...input,
      closedSteps: [
        {
          ordinal: 1,
          slug: 'plan',
          outcome: 'partial',
          oldFloors: [floor('task-open-with-notes')],
          newFloors: [floor('task-open-with-notes', { requirePullRequest: true })],
        },
      ],
    }),
  ).toMatchObject({
    action: 'refuse',
    message: expect.stringContaining(
      'step 1 plan outcome partial floor task-open-with-notes differs in requirePullRequest',
    ),
  })
})

test('repin refuses a non-holder and pending decisions', () => {
  expect(decideWorkflowRepin({ ...input, callerSession: 'session-two' }).action).toBe('refuse')
  expect(decideWorkflowRepin({ ...input, pendingQuestion: true }).action).toBe('refuse')
  expect(decideWorkflowRepin({ ...input, pendingAwait: true }).action).toBe('refuse')
})
