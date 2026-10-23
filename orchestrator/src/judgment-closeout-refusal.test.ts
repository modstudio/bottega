import { describe, expect, test } from 'bun:test'
import { findingsCloseOutRefusal } from './judgment-closeout-refusal.ts'

describe('findings close-out refusal', () => {
  test('a findings job scored none names supplied findings and grades with both remedies', () => {
    expect(
      findingsCloseOutRefusal({
        runId: '42',
        jobName: 'review-lens',
        findingsJob: true,
        delivery: 'none',
        suppliedFlags: ['finding', 'coverage', 'limits'],
      }),
    ).toBe(
      'review-lens run 42 was scored delivery none, which takes no findings or review grades (--finding, --coverage, --limits); if the lens delivered a review, score its delivery partial or full and grade it; otherwise drop these flags and put the facts in --note',
    )
  })

  test('a non-findings job names the close-out flags it does not take', () => {
    expect(
      findingsCloseOutRefusal({
        runId: '43',
        jobName: 'file-question',
        findingsJob: false,
        delivery: 'full',
        suppliedFlags: ['duplicate', 'overlap'],
      }),
    ).toBe(
      'file-question is not a findings-producing lens and does not take findings close-out flags (--duplicate, --overlap)',
    )
  })
})
