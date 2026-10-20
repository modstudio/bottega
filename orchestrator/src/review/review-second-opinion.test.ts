import { expect, test } from 'bun:test'
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
