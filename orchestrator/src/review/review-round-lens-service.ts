// concern: review-round-lens-service
/** Gathers stored review facts and applies the pure round lens plan. */

import type { Database } from 'bun:sqlite'
import type { ReviewSettings } from '../project/project-injection.ts'
import { type ApplicableReview, pathScopedLenses } from './review-applicability.ts'
import { type ChangeGroup, reviewsForTriage, serializePathSet } from './review-group.ts'
import type { PostFixReviewDecision } from './review-post-fix.ts'
import { applicableRoundLensPlan, roundLensFacts } from './review-round-lens-plan.ts'

/** Assemble the round plan from the current change, branch review history, and project declaration. */
export function roundApplicabilityForChange(input: {
  database: Database
  group: ChangeGroup
  relevant: ApplicableReview
  postFix: PostFixReviewDecision
  review: ReviewSettings | undefined
}): ApplicableReview {
  return applicableRoundLensPlan({
    relevant: input.relevant,
    facts: roundLensFacts(reviewsForTriage(input.database, input.group).branchReviews, {
      patchId: input.group.patchId,
      pathSet: serializePathSet(input.group.pathSet),
    }),
    postFix: input.postFix,
    pathScopedLenses: pathScopedLenses(input.review),
  })
}
