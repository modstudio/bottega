import { describe, expect, test } from 'bun:test'
import { applicableReviewLenses } from './review-applicability.ts'

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
})
