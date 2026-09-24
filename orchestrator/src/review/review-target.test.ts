import { describe, expect, test } from 'bun:test'
import { emptyReviewRefusal, reviewTrunkRef } from './review-target.ts'

describe('review target', () => {
  test('uses the remote-tracking trunk when it exists', () => {
    expect(reviewTrunkRef(true, 'main')).toBe('origin/main')
  })

  test('falls back to the local trunk when no remote-tracking ref exists', () => {
    expect(reviewTrunkRef(false, 'main')).toBe('main')
  })

  test('refuses a ref whose commit is its trunk merge base', () => {
    expect(
      emptyReviewRefusal('1234567890abcdef', '1234567890abcdef', 'mistaken-base', 'main'),
    ).toBe(
      'refused: --review mistaken-base resolves to 12345678, which is already on main, so there is no change to review. Pass the branch under review (the ref whose commits are not on main), not its base.',
    )
  })

  test('allows a commit after its trunk merge base', () => {
    expect(emptyReviewRefusal('branch-tip', 'fork-point', 'feature', 'main')).toBeNull()
  })
})
