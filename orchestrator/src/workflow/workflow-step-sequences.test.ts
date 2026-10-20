import { expect, test } from 'bun:test'
import {
  expandWorkflowSteps,
  inspectWorkflowSteps,
  workflowModeStepError,
} from './workflow-step-sequences.ts'

test('a sequence reference expands in place to the same flat step order', () => {
  const sequences = [{ slug: 'quality', title: 'Quality', steps: ['review', 'verify'] }]
  expect(expandWorkflowSteps(['prepare', { sequence: 'quality' }, 'finish'], sequences)).toEqual([
    'prepare',
    'review',
    'verify',
    'finish',
  ])
})

test('a sequence reference omits named members and rejects a non-member', () => {
  const sequences = [{ slug: 'quality', title: 'Quality', steps: ['review', 'verify'] }]
  expect(expandWorkflowSteps([{ sequence: 'quality', omit: ['review'] }], sequences)).toEqual([
    'verify',
  ])
  expect(
    inspectWorkflowSteps(
      [{ sequence: 'quality', omit: ['absent'] }],
      sequences,
      new Set(['review', 'verify']),
    ).invalidOmissions,
  ).toEqual([{ sequence: 'quality', step: 'absent' }])
})

test('a workflow step entry accepts only a slug or an exact sequence reference', () => {
  expect(workflowModeStepError({ sequence: 'quality', extra: true })).toContain(
    'must be a step slug or exactly',
  )
  expect(workflowModeStepError({ step: 'review' })).toContain('must be a step slug or exactly')
  expect(workflowModeStepError({ sequence: 4 })).toContain('must be a step slug or exactly')
})
