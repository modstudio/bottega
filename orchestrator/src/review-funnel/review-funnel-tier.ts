// concern: review-funnel-tier
/** Owns tier classification plus the project declaration's applicable lenses. */

import type { ReviewSettings } from '../project/project-injection.ts'
import { type ApplicableReview, applicableReview } from '../review/review-applicability.ts'
import {
  classifyReviewTier,
  type ReviewTier,
  type ReviewTierFile,
} from '../review/review-tier-classifier.ts'

export type ReviewPlan = {
  tier: ReviewTier
  applicability: ApplicableReview
}

/** Classify one change and select its review lenses from those same file facts. */
export function applicableReviewForChange(
  files: ReviewTierFile[],
  review: ReviewSettings | undefined,
): ReviewPlan {
  const tier = classifyReviewTier({ files, risk: review?.risk })
  return {
    tier,
    applicability: applicableReview(
      tier.tier,
      files.map(({ path }) => path),
      review,
    ),
  }
}
