// concern: review-tier service
/** Computes the tier and declared lenses for an already-resolved change range. */

import type { ReviewSettings } from '../project/project-injection.ts'
import { applicableReviewForChange } from './review-applicability.ts'
import { diffNumstat } from './review-tier.ts'

export function reviewTierForRange(
  repo: string,
  from: string,
  to: string,
  review: ReviewSettings | undefined,
) {
  const files = diffNumstat(repo, from, to)
  const plan = applicableReviewForChange(files, review)
  return {
    ...plan.tier,
    risk_map: review?.risk ? 'project declaration' : 'fail-closed default',
    ...plan.applicability,
  }
}
