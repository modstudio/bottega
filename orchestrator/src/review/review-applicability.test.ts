import { describe, expect, test } from 'bun:test'
import { applicableReview, applicableReviewLenses } from './review-applicability.ts'

describe('applicable review lenses', () => {
  const review = {
    lenses: [
      { lens: 'correctness' },
      { lens: 'migration-safety', paths: ['**/migrations/**'] },
      { lens: 'craft', minTier: 2 as const },
      { lens: 'correctness', paths: ['orchestrator/**'] },
    ],
  }

  test('selects always-on and path lenses at tier one', () => {
    expect(
      applicableReviewLenses(1, ['shared/record/migrations/next/migration.sql'], review),
    ).toEqual(['correctness', 'migration-safety'])
  })

  test('applies minimum tier, path exclusion, and duplicate collapse', () => {
    expect(applicableReviewLenses(2, ['orchestrator/src/review/review-tier.ts'], review)).toEqual([
      'correctness',
      'craft',
    ])
  })

  test('tier zero is empty', () => {
    expect(
      applicableReviewLenses(0, ['shared/record/migrations/next/migration.sql'], review),
    ).toEqual([])
  })

  test('an undeclared project uses the built-in declaration', () => {
    expect(
      applicableReviewLenses(3, ['orchestrator/src/review/review-tier.ts'], undefined),
    ).toEqual(['correctness', 'craft', 'safety'])
  })

  test('selects a declared second opinion at its minimum tier', () => {
    expect(applicableReview(3, ['orchestrator/src/review/review-tier.ts'], review)).toEqual({
      lenses: ['correctness', 'craft'],
    })
    expect(
      applicableReview(2, ['orchestrator/src/review/review-tier.ts'], {
        ...review,
        secondOpinion: { lens: 'craft', minTier: 3 },
      }),
    ).toEqual({ lenses: ['correctness', 'craft'] })
    expect(
      applicableReview(3, ['orchestrator/src/review/review-tier.ts'], {
        ...review,
        secondOpinion: { lens: 'craft' },
      }),
    ).toEqual({ lenses: ['correctness', 'craft'], secondOpinion: 'craft' })
    expect(
      applicableReview(3, ['orchestrator/src/review/review-tier.ts'], {
        lenses: [{ lens: 'correctness' }],
        secondOpinion: { lens: 'safety' },
      }),
    ).toEqual({ lenses: ['correctness', 'safety'], secondOpinion: 'safety' })
  })
})
