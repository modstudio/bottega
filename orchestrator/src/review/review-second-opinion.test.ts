import { expect, test } from 'bun:test'
import { decideSecondOpinion } from '../pull-request/triage-decision.ts'
import type { TriageReviewRow } from './review-group.ts'
import { identifySecondOpinionRun, type SecondOpinionRun } from './review-second-opinion.ts'

const opinion = (
  recordId: string,
  runId: string,
  model: string,
  overrides: Partial<SecondOpinionRun> = {},
): SecondOpinionRun => ({
  recordId,
  runId,
  lens: 'correctness',
  model,
  graded: true,
  completed: true,
  ...overrides,
})

test('identifies both credited run ids in record order', () => {
  expect(
    identifySecondOpinionRun(
      [opinion('lens-2', 'run-2', 'model-b'), opinion('lens-1', 'run-1', 'model-a')],
      'correctness',
    ),
  ).toEqual({ firstRunId: 'run-1', secondRunId: 'run-2' })
})

test('requires completed graded runs of the requested lens on distinct models', () => {
  expect(
    identifySecondOpinionRun(
      [
        opinion('lens-1', 'run-1', 'model-a'),
        opinion('lens-2', 'run-2', 'model-a'),
        opinion('lens-3', 'run-3', 'model-b', { graded: false }),
        opinion('lens-4', 'run-4', 'model-c', { lens: 'craft' }),
      ],
      'correctness',
    ),
  ).toBeNull()
})

test('does not credit an earlier delivery-none run as a distinct-model opinion', () => {
  expect(
    identifySecondOpinionRun(
      [
        opinion('lens-1', 'run-none', 'grok-4.6', { graded: false }),
        opinion('lens-2', 'run-graded', 'gpt-5.6-sol'),
      ],
      'correctness',
    ),
  ).toBeNull()
})

test('a second opinion requires two completed runs on different models', () => {
  const reviews = (...opinions: SecondOpinionRun[]): TriageReviewRow[] => [
    {
      reviewRecordId: 'review-1',
      reviewNumber: 1,
      recordedAt: '2026-09-25T00:00:00Z',
      completedAt: '2026-09-25T01:00:00Z',
      tier: 1,
      role: 'round',
      patchId: 'patch',
      pathSet: '["a.ts"]',
      lensIdentities: ['correctness'],
      lenses: opinions.map((row) => ({ ...row, settled: row.graded })),
      findings: [],
    },
  ]

  expect(decideSecondOpinion(reviews(opinion('lens-1', '101', 'model-a')), 'correctness')).toEqual({
    complete: false,
    lens: 'correctness',
    firstRunId: '101',
  })
  expect(
    decideSecondOpinion(
      reviews(opinion('lens-1', '101', 'model-a'), opinion('lens-2', '102', 'model-a')),
      'correctness',
    ),
  ).toEqual({ complete: false, lens: 'correctness', firstRunId: '101' })
  expect(
    decideSecondOpinion(
      reviews(opinion('lens-1', '101', 'model-a'), opinion('lens-2', '102', 'model-b')),
      'correctness',
    ),
  ).toEqual({ complete: true })
})
