import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { CursorTrailEntry } from './workflow-cursor-trail.ts'
import { decideWorkflowRepin, type RepinStep } from './workflow-repin-decision.ts'

const closed: CursorTrailEntry[] = [
  { n: 1, slug: 'plan', note: 'planned', at: '2026-11-20T00:00:00.000Z' },
]
const oldSteps: RepinStep[] = [
  { slug: 'plan', floors: ['recorded-artifact'] },
  { slug: 'close-task', floors: ['tracker-transition'] },
  { slug: 'later', floors: ['command-exit'] },
]
const input = {
  cursor: 1206,
  oldSteps,
  newSteps: oldSteps,
  currentOrdinal: 1,
  trail: closed,
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
      newSteps: [
        { ...oldSteps[0]!, floors: ['recorded-artifact', 'ruling'] },
        oldSteps[1]!,
        oldSteps[2]!,
      ],
    }),
  ).toMatchObject({ action: 'refuse', message: expect.stringContaining('adds floor ruling') })
})

test('repin allows current-step floor changes and later-step changes', () => {
  expect(
    decideWorkflowRepin({
      ...input,
      newSteps: [
        oldSteps[0]!,
        { ...oldSteps[1]!, floors: ['task-open-with-notes'] },
        { slug: 'replacement', floors: ['ruling'] },
      ],
    }),
  ).toEqual({ action: 'allow' })
})

test('repin refuses a non-holder and pending decisions', () => {
  expect(decideWorkflowRepin({ ...input, callerSession: 'session-two' }).action).toBe('refuse')
  expect(decideWorkflowRepin({ ...input, pendingQuestion: true }).action).toBe('refuse')
  expect(decideWorkflowRepin({ ...input, pendingAwait: true }).action).toBe('refuse')
})
