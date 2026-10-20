import { expect, test } from 'bun:test'
import type { CatalogueStep } from './step-catalogue-definition.ts'
import {
  expandWorkflowSteps,
  inspectWorkflowSteps,
  workflowConditionErrors,
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

test('reentry to must be an earlier step in the expanded mode', () => {
  const catalogue: CatalogueStep[] = [
    {
      slug: 'start',
      title: 'Start',
      body: '',
      floor: ['ruling'],
      job: null,
      autonomy: 'auto',
      needs: [],
    },
    {
      slug: 'apply',
      title: 'Apply',
      body: '',
      floor: ['ruling'],
      job: null,
      autonomy: 'auto',
      needs: [],
      outcomes: ['changed', 'clean'],
      reenter: { to: 'start', outcome: 'changed' },
    },
    {
      slug: 'finish',
      title: 'Finish',
      body: '',
      floor: ['ruling'],
      job: null,
      autonomy: 'auto',
      needs: [],
    },
  ]
  expect(
    workflowConditionErrors('default', [{ slug: 'start' }, { slug: 'apply' }], catalogue),
  ).toEqual([])
  expect(
    workflowConditionErrors('default', [{ slug: 'apply' }, { slug: 'start' }], catalogue),
  ).toContain(
    'mode "default" step "apply" reentry to "start" must be an earlier step in the expanded mode',
  )
  expect(
    workflowConditionErrors('ship', [{ slug: 'apply' }, { slug: 'finish' }], catalogue),
  ).toContain(
    'mode "ship" step "apply" reentry to "start" must be an earlier step in the expanded mode',
  )
})
