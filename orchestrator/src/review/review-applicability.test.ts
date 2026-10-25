import { describe, expect, test } from 'bun:test'
import {
  applicablePostFixReview,
  applicableReview,
  applicableReviewForChange,
  lensesSelectingPaths,
} from './review-applicability.ts'

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
      applicableReview(1, ['shared/record/migrations/next/migration.sql'], review).lenses,
    ).toEqual(['correctness', 'migration-safety'])
  })

  test('applies minimum tier, path exclusion, and duplicate collapse', () => {
    expect(applicableReview(2, ['orchestrator/src/review/review-tier.ts'], review).lenses).toEqual([
      'correctness',
      'craft',
    ])
  })

  test('maps scoped lenses to the paths that select them', () => {
    expect(
      lensesSelectingPaths(
        ['shared/record/migrations/next/migration.sql', 'orchestrator/src/review.ts', 'docs/a.md'],
        review,
      ),
    ).toEqual({
      'migration-safety': ['shared/record/migrations/next/migration.sql'],
      correctness: ['orchestrator/src/review.ts'],
    })
  })

  test('tier zero is empty', () => {
    expect(
      applicableReview(0, ['shared/record/migrations/next/migration.sql'], review).lenses,
    ).toEqual([])
  })

  test('an undeclared project uses the built-in declaration', () => {
    expect(
      applicableReview(3, ['orchestrator/src/review/review-tier.ts'], undefined).lenses,
    ).toEqual(['correctness', 'craft', 'safety'])
  })

  test('skip omits unscoped lenses except correctness', () => {
    expect(
      applicableReview(2, ['src/change.ts'], {
        lenses: [{ lens: 'correctness' }, { lens: 'craft' }],
        unscopedLenses: 'skip',
      }).lenses,
    ).toEqual(['correctness'])
  })

  test('post-fix selection applies the unscoped lens switch', () => {
    expect(
      applicablePostFixReview(2, ['src/change.ts'], {
        lenses: [{ lens: 'correctness' }, { lens: 'craft' }],
        unscopedLenses: 'skip',
      }).lenses,
    ).toEqual(['correctness'])
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
      applicableReview(2, ['orchestrator/src/review/review-tier.ts'], {
        lenses: [{ lens: 'correctness' }],
        secondOpinion: { lens: 'safety' },
      }),
    ).toEqual({ lenses: ['correctness'] })
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

  test('skip omits an unscoped second opinion', () => {
    expect(
      applicableReview(3, ['src/change.ts'], {
        lenses: [{ lens: 'correctness' }, { lens: 'craft' }],
        secondOpinion: { lens: 'craft' },
        unscopedLenses: 'skip',
      }),
    ).toEqual({ lenses: ['correctness'] })
  })

  test('skip runs a matching scoped second opinion independently of its ordinary minimum tier', () => {
    expect(
      applicableReview(2, ['critical/change.ts'], {
        lenses: [{ lens: 'correctness' }, { lens: 'safety', minTier: 3, paths: ['critical/**'] }],
        secondOpinion: { lens: 'safety', minTier: 2 },
        unscopedLenses: 'skip',
      }),
    ).toEqual({ lenses: ['correctness', 'safety'], secondOpinion: 'safety' })
  })

  test('carries the evidence basis for selected rules', () => {
    expect(
      applicableReview(3, ['orchestrator/src/review/review-tier.ts'], {
        lenses: [{ lens: 'correctness', basis: 'yield evidence' }],
        secondOpinion: { lens: 'correctness', basis: 'escaped defect evidence' },
      }),
    ).toEqual({
      lenses: ['correctness'],
      lensBases: { correctness: 'yield evidence' },
      secondOpinion: 'correctness',
      secondOpinionBasis: 'escaped defect evidence',
    })
  })

  test('a post-fix second opinion applies only when its lens dimension was touched', () => {
    const declaration = {
      lenses: [{ lens: 'correctness' }, { lens: 'safety', paths: ['critical/**'] }],
      secondOpinion: { lens: 'safety' },
    }
    expect(applicablePostFixReview(3, ['src/fix.ts'], declaration)).toEqual({
      lenses: ['correctness'],
    })
    expect(applicablePostFixReview(3, ['critical/fix.ts'], declaration)).toEqual({
      lenses: ['correctness', 'safety'],
      secondOpinion: 'safety',
    })
  })

  test('a tier-two segnavia-shaped source change excludes its test-only lens', () => {
    const plan = applicableReviewForChange(
      [{ path: 'packages/format/src/slots.ts', insertions: 11, deletions: 0 }],
      {
        lenses: [
          { lens: 'correctness' },
          { lens: 'craft', minTier: 2 },
          { lens: 'test-quality', minTier: 2, paths: ['**/*.test.ts', 'scripts/verify/**'] },
        ],
        risk: {
          paths: [{ pattern: '^packages/format/src/', tier: 2, reason: 'stored format' }],
          unlisted: 1,
        },
      },
    )

    expect(plan.tier.tier).toBe(2)
    expect(plan.applicability.lenses).toEqual(['correctness', 'craft'])
  })
})
