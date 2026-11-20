import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  decideFloorSatisfaction,
  type Floor,
  type FloorSatisfactionInput,
} from './workflow-floor.ts'

const floor = (kind: Floor['kind']): Floor => ({
  kind,
  deferrable: false,
  expectedExitCode: 0,
  expectedStatus: 'done',
  requirePullRequest: false,
  operatorRuling: false,
})
const tracker = floor('tracker-transition')
const artifact = floor('recorded-artifact')
const dispatchStep = { slug: 'start', jobs: ['implement'], dispatch: 'required' as const }
const terminalDispatch = { number: 41, job: 'implement', terminal: true, needsVerdict: false }
const closedTask = {
  task: {
    key: 'DEV-1',
    status: 'done',
    statusCategory: 'done',
    mergedPullRequest: false,
    trackerStates: {},
  },
}
const decide = (input: Partial<FloorSatisfactionInput> & Pick<FloorSatisfactionInput, 'floors'>) =>
  decideFloorSatisfaction({
    evidence: {},
    enforcement: 'floors',
    finishing: false,
    openObligations: [],
    ...input,
  })

test.each([
  ['zero runs', [], 'no implement run was dispatched'],
  ['a running chain', [{ ...terminalDispatch, terminal: false }], 'run 41 is not terminal'],
  [
    'an unscored terminal chain',
    [{ ...terminalDispatch, needsVerdict: true }],
    'run 41 still needs a verdict',
  ],
] as const)('a required dispatch refuses %s', (_name, dispatchRuns, message) => {
  const decision = decide({
    floors: [tracker],
    evidence: { ...closedTask, dispatchRuns: [...dispatchRuns] },
    workflowKey: 'DEV-1',
    step: dispatchStep,
  })
  expect(decision).toMatchObject({ action: 'refuse' })
  if (decision.action === 'refuse') expect(decision.message).toContain(message)
})

test.each(['scored', 'voided'])('a terminal %s dispatch allows', () => {
  expect(
    decide({
      floors: [tracker],
      evidence: { ...closedTask, dispatchRuns: [terminalDispatch] },
      workflowKey: 'DEV-1',
      step: dispatchStep,
    }).action,
  ).toBe('allow')
})

test('a chain filtered out for another cursor or step does not count as the dispatch', () => {
  expect(
    decide({
      floors: [tracker],
      evidence: { ...closedTask, dispatchRuns: [] },
      workflowKey: 'DEV-1',
      step: dispatchStep,
    }).action,
  ).toBe('refuse')
})

test('a terminal unscored review lens satisfies its dispatch step', () => {
  expect(
    decide({
      floors: [artifact],
      evidence: {
        artifacts: [{ artifact: { ref: 'probe:3', exists: true } }],
        dispatchRuns: [{ number: 51, job: 'review-lens', terminal: true, needsVerdict: true }],
      },
      workflowKey: 'DEV-1',
      step: { slug: 'review-lenses', jobs: ['review-lens'], dispatch: 'required' },
    }).action,
  ).toBe('allow')
})

test('a judging step refuses an unscored lens chain', () => {
  const decision = decide({
    floors: [],
    evidence: {
      judgedRuns: [{ number: 51, job: 'review-lens', terminal: true, needsVerdict: true }],
    },
    workflowKey: 'DEV-1',
    step: { slug: 'triage-findings', jobs: [], judges: ['review-lens'] },
  })
  expect(decision).toMatchObject({ action: 'refuse' })
  if (decision.action === 'refuse') expect(decision.message).toContain(`${PLATFORM_SLUG} score 51`)
})

test.each([
  ['review-lenses', 'no-lens-owed'],
  ['apply-findings', 'no-accepted-findings'],
] as const)('a true %s waiver fact allows zero dispatches', (slug, fact) => {
  expect(
    decide({
      floors: [artifact],
      evidence: {
        artifacts: [{ artifact: { ref: 'probe:3', exists: true } }],
        metDispatchWaiverFacts: [fact],
      },
      workflowKey: 'DEV-1',
      step: { ...dispatchStep, slug, dispatchWaivedBy: [fact] },
    }).action,
  ).toBe('allow')
})

test.each([
  ['review-lenses', 'no-lens-owed'],
  ['apply-findings', 'no-accepted-findings'],
] as const)('a false %s waiver fact refuses zero dispatches', (slug, fact) => {
  expect(
    decide({
      floors: [artifact],
      evidence: { artifacts: [{ artifact: { ref: 'probe:3', exists: true } }] },
      workflowKey: 'DEV-1',
      step: { ...dispatchStep, slug, dispatchWaivedBy: [fact] },
    }).action,
  ).toBe('refuse')
})

test('a selected descendants-closed floor allows zero dispatches', () => {
  expect(
    decide({
      floors: [floor('descendants-closed')],
      evidence: { ...closedTask, descendants: [] },
      workflowKey: 'DEV-1',
      step: dispatchStep,
    }).action,
  ).toBe('allow')
})
