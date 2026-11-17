import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { strandedWorkflowQuestionRemedy } from './workflow-stranded-question.ts'

const openQuestion = {
  number: 6452,
  record_id: '01990000-0000-7000-8000-000000002391',
  workflow_step_ordinal: null,
  workflow_step_slug: null,
  answered_at: null,
  closed_at: null,
}

test('an unbound open cursor question is named with its recovery', () => {
  expect(strandedWorkflowQuestionRemedy([openQuestion], 'running')).toBe(
    `question 6452 (record ${openQuestion.record_id}) is open on this cursor but carries no step, so no workflow verb can rule on it; close it with \`${PLATFORM_SLUG} question close ${openQuestion.record_id} --reason <why>\`, then record the question again with \`${PLATFORM_SLUG} workflow await\``,
  )
})

test('an unbound open question on an awaiting cursor points to await before close', () => {
  expect(strandedWorkflowQuestionRemedy([openQuestion], 'awaiting-ruling')).toBe(
    `question 6452 (record ${openQuestion.record_id}) is open on this cursor but carries no step, so no workflow verb can rule on it; record the question again with \`${PLATFORM_SLUG} workflow await\`, which records a new question bound to this step. Question 6452 can be closed with \`${PLATFORM_SLUG} question close ${openQuestion.record_id} --reason <why>\` once the cursor is no longer awaiting a ruling`,
  )
})

test('a bound open cursor question is not stranded', () => {
  expect(
    strandedWorkflowQuestionRemedy(
      [{ ...openQuestion, workflow_step_ordinal: 7, workflow_step_slug: 'design-signoff' }],
      'running',
    ),
  ).toBeNull()
})

test.each([
  ['answered', { answered_at: '2026-11-17T02:51:45.050Z' }],
  ['closed', { closed_at: '2026-11-17T14:45:00.000Z' }],
])('an unbound %s cursor question is not stranded', (_name, state) => {
  expect(strandedWorkflowQuestionRemedy([{ ...openQuestion, ...state }], 'running')).toBeNull()
})
