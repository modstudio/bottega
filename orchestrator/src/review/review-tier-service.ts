// concern: review-tier service
/** Computes the tier and declared lenses for an already-resolved change range. */

import type { ReviewSettings } from '../project/project-injection.ts'
import { applicableReviewLenses } from './review-applicability.ts'
import { classifyReviewTier, diffNumstat } from './review-tier.ts'

export function reviewTierForRange(
  repo: string,
  from: string,
  to: string,
  review: ReviewSettings | undefined,
) {
  const files = diffNumstat(repo, from, to)
  const tier = classifyReviewTier({ files })
  return {
    ...tier,
    lenses: applicableReviewLenses(
      tier.tier,
      files.map(({ path }) => path),
      review,
    ),
  }
}
