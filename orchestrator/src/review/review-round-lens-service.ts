// concern: review-round-lens-service
/** Gathers stored review facts and applies the pure round lens plan. */

import type { Database } from 'bun:sqlite'
import type { ReviewSettings } from '../project/project-injection.ts'
import {
  type ApplicableReview,
  lensesSelectingPaths,
  type ReviewFunnelPlan,
} from './review-applicability.ts'
import { type ChangeGroup, reviewsForTriage, serializePathSet } from './review-group.ts'
import type { PostFixReviewDecision } from './review-post-fix.ts'
import {
  type ReviewRoundBudgetDecision,
  type ReviewTierNumber,
  reviewBudgetForBranch,
  reviewRoundBudgetDecision,
} from './review-round-budget.ts'
import {
  applicableRoundLensPlan,
  reviewRoundForBudget,
  roundLensFacts,
} from './review-round-lens-plan.ts'
import { reviewRoundIdentity } from './review-yield.ts'

/** Assemble the round plan from the current change, branch review history, and project declaration. */
export function roundApplicabilityForChange(input: {
  database: Database
  group: ChangeGroup
  relevant: ApplicableReview
  postFix: PostFixReviewDecision
  review: ReviewSettings | undefined
}): ReviewFunnelPlan {
  const fixPaths = input.postFix.kind === 're-lens' ? input.postFix.fixPaths : []
  const fixPathsByLens = lensesSelectingPaths(fixPaths, input.review)
  return applicableRoundLensPlan({
    relevant: input.relevant,
    facts: roundLensFacts(reviewsForTriage(input.database, input.group).branchReviews, {
      patchId: input.group.patchId,
      pathSet: serializePathSet(input.group.pathSet),
    }),
    postFix: input.postFix,
    fixPathsByLens,
  })
}

export type BudgetedReviewPlan = {
  reviewPlan: ReviewFunnelPlan
  reviewBudget: ReviewRoundBudgetDecision & {
    eligibleReviewCount: number
    unclassifiableReviewCount: number
  }
}

/** Assemble the funnel plan and apply the branch's review-round budget. */
export function budgetedRoundApplicabilityForChange(
  input: Parameters<typeof roundApplicabilityForChange>[0] & { tier: ReviewTierNumber },
): BudgetedReviewPlan {
  const reviewPlan = roundApplicabilityForChange(input)
  const currentRoundIdentity = reviewRoundIdentity({
    launch_key: null,
    branch: input.group.branch,
    patch_id: input.group.patchId,
    path_set: serializePathSet(input.group.pathSet),
  }).identity
  const branchBudget = reviewBudgetForBranch(
    input.database,
    input.group.project,
    input.group.branch,
    currentRoundIdentity,
  )
  const reviewBudget = reviewRoundBudgetDecision({
    tier: input.tier,
    ...branchBudget,
    roundNeeded: reviewPlan.round.lenses.length > 0 || Boolean(reviewPlan.round.secondOpinion),
  })
  return {
    reviewPlan: {
      ...reviewPlan,
      round: reviewRoundForBudget(reviewPlan.round, reviewBudget),
    },
    reviewBudget: {
      ...reviewBudget,
      eligibleReviewCount: branchBudget.eligibleReviewCount,
      unclassifiableReviewCount: branchBudget.unclassifiableReviewCount,
    },
  }
}
