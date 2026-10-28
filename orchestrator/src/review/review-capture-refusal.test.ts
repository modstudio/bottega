import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type ReviewOutputState, reviewCaptureRefusal } from './review-capture-refusal.ts'

describe('review capture refusal', () => {
  const cases: { state: ReviewOutputState; condition: string; remedy: string }[] = [
    {
      state: 'invalid',
      condition: 'output does not satisfy the review contract',
      remedy: `${PLATFORM_SLUG} score run-42 none --note "<why the output failed the contract>"`,
    },
    {
      state: 'missing',
      condition: 'has no recorded output',
      remedy: `${PLATFORM_SLUG} score run-42 none --note "<why no output was recorded>"`,
    },
  ]

  for (const { state, condition, remedy } of cases) {
    test(`${state} output names its condition and remedy`, () => {
      const refusal = reviewCaptureRefusal('run-42', state)

      expect(refusal).toContain(condition)
      expect(refusal).toContain(remedy)
    })
  }

  test('invalid output preserves usable findings for manual triage', () => {
    expect(reviewCaptureRefusal('run-42', 'invalid')).toContain(
      'usable findings can be carried into triage by hand',
    )
  })
})
