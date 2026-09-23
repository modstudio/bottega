import { describe, expect, test } from 'bun:test'
import { emptyReviewRefusal } from './review-target.ts'

describe('review target', () => {
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
