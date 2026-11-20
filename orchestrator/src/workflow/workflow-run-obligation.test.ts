import { expect, test } from 'bun:test'
import {
  dispatchObligationRefusal,
  type EarlierStepDispatchEvidence,
} from './workflow-run-obligation.ts'

const candidate = {
  number: 41,
  job: 'implement',
  terminal: true,
  terminalOk: true,
  needsVerdict: false,
  finishedAt: '2026-11-19T12:00:02.000Z',
  headCommit: 'reviewed-tip',
}

const earlierStepDispatch = (
  change: Partial<EarlierStepDispatchEvidence> = {},
): EarlierStepDispatchEvidence => ({
  candidates: [candidate],
  latestAcceptedDispositionAt: '2026-11-19T12:00:01.000Z',
  branchTip: 'reviewed-tip',
  reviewedTips: ['reviewed-tip'],
  ...change,
})

const refusal = (evidence: EarlierStepDispatchEvidence) =>
  dispatchObligationRefusal({
    workflowKey: 'DEV-1',
    selectedFloors: [],
    metWaiverFacts: [],
    step: {
      slug: 'apply-findings',
      jobs: ['implement'],
      dispatch: 'required',
      dispatchWaivedBy: ['no-accepted-findings'],
    },
    earlierStepDispatch: evidence,
  })

test('an earlier-step turn after triage at the reviewed tip is credited', () => {
  expect(refusal(earlierStepDispatch())).toBeNull()
})

test('an earlier-step turn before triage refuses', () => {
  expect(
    refusal(
      earlierStepDispatch({
        candidates: [{ ...candidate, finishedAt: '2026-11-19T12:00:00.000Z' }],
      }),
    ),
  ).toContain('no implement run was dispatched')
})

test('an earlier-step turn whose head is no longer the branch tip refuses', () => {
  expect(refusal(earlierStepDispatch({ branchTip: 'moved-tip' }))).toContain(
    'no implement run was dispatched',
  )
})

test('an earlier-step turn at a tip with no review read refuses', () => {
  expect(refusal(earlierStepDispatch({ reviewedTips: [] }))).toContain(
    'no implement run was dispatched',
  )
})

test('a credited earlier-step turn still needs its verdict', () => {
  expect(
    refusal(earlierStepDispatch({ candidates: [{ ...candidate, needsVerdict: true }] })),
  ).toContain('run 41 still needs a verdict')
})
