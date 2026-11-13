import { describe, expect, test } from 'bun:test'
import { decideReviewOwedFloor } from './workflow-review-owed-decision.ts'

const verdict = (status: 'owed' | 'satisfied' | 'waived-at-ceiling' | 'overridden') => ({
  lenses: [
    { lens: 'correctness', status, reason: status === 'owed' ? ('initial' as const) : status },
  ],
  remedy: 'bottega run start review-lens --review DEV-2302-work',
})

describe('review-owed floor', () => {
  test('refuses owed lenses and names the funnel remedy', () => {
    expect(decideReviewOwedFloor(verdict('owed'))).toEqual({
      action: 'refuse',
      message:
        'floor review-owed is unmet; owed lenses: correctness; remedy: `bottega run start review-lens --review DEV-2302-work`',
    })
  })

  test.each(['satisfied', 'waived-at-ceiling', 'overridden'] as const)(
    'allows a %s lens',
    (status) => expect(decideReviewOwedFloor(verdict(status))).toEqual({ action: 'allow' }),
  )
})
