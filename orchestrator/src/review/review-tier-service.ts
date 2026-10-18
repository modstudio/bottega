// concern: review-tier service
/** Computes the tier and declared lenses for an already-resolved change range. */

import type { ReviewSettings } from '../project/project-injection.ts'
import { applicableReview } from './review-applicability.ts'
import { classifyReviewTier, diffNumstat } from './review-tier.ts'

export function reviewTierForRange(
  repo: string,
  from: string,
  to: string,
  review: ReviewSettings | undefined,
) {
  const files = diffNumstat(repo, from, to)
  const tier = classifyReviewTier({ files, risk: review?.risk })
  const applicability = applicableReview(
    tier.tier,
    files.map(({ path }) => path),
    review,
  )
  return {
    ...tier,
    risk_map: review?.risk ? 'project declaration' : 'fail-closed default',
    ...applicability,
  }
}
