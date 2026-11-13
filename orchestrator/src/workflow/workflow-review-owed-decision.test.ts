import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideReviewOwedFloor } from './workflow-review-owed-decision.ts'

const verdict = (
  status: 'owed' | 'running' | 'untriaged' | 'satisfied' | 'waived-at-ceiling' | 'overridden',
) => ({
  lenses: [
    { lens: 'correctness', status, reason: status === 'owed' ? ('initial' as const) : status },
  ],
  remedy: `${PLATFORM_SLUG} run start review-lens --review DEV-2302-work`,
})

describe('review-owed floor', () => {
  test.each(['owed', 'running', 'untriaged'] as const)(
    'refuses a %s lens with its status and the funnel remedy',
    (status) => {
      expect(decideReviewOwedFloor(verdict(status))).toEqual({
        action: 'refuse',
        message: `floor review-owed is unmet; blocking lenses: correctness (${status}); remedy: \`${PLATFORM_SLUG} run start review-lens --review DEV-2302-work\``,
      })
    },
  )

  test.each(['satisfied', 'waived-at-ceiling', 'overridden'] as const)(
    'allows a %s lens',
    (status) => expect(decideReviewOwedFloor(verdict(status))).toEqual({ action: 'allow' }),
  )
})
