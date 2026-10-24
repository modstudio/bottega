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
  reviewPlanForBudget,
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
  creditedByArchitectRead: ApplicableReview
  reviewBudget: ReviewRoundBudgetDecision & {
    eligibleReviewCount: number
    unclassifiableReviewCount: number
  }
}

/** Assemble the funnel plan and apply the branch's review-round budget. */
export function budgetedRoundApplicabilityForChange(
  input:
    | (Parameters<typeof roundApplicabilityForChange>[0] & { tier: ReviewTierNumber })
    | {
        database: Database
        project: string
        branch: string
        relevant: ApplicableReview
        tier: ReviewTierNumber
      },
): BudgetedReviewPlan {
  const knownIdentity = 'group' in input
  const facts = knownIdentity
    ? roundLensFacts(reviewsForTriage(input.database, input.group).branchReviews, {
        patchId: input.group.patchId,
        pathSet: serializePathSet(input.group.pathSet),
      })
    : {
        reviewedPathsByLens: {},
        completedLenses: [],
        satisfiedSecondOpinionLenses: [],
        latestAcceptedOrModifiedLenses: [],
      }
  const reviewPlan = knownIdentity
    ? applicableRoundLensPlan({
        relevant: input.relevant,
        facts,
        postFix: input.postFix,
        fixPathsByLens: lensesSelectingPaths(
          input.postFix.kind === 're-lens' ? input.postFix.fixPaths : [],
          input.review,
        ),
      })
    : { round: input.relevant, admissionRequired: input.relevant }
  const project = knownIdentity ? input.group.project : input.project
  const branch = knownIdentity ? input.group.branch : input.branch
  const currentRoundIdentity = knownIdentity
    ? reviewRoundIdentity({
        launch_key: null,
        branch,
        patch_id: input.group.patchId,
        path_set: serializePathSet(input.group.pathSet),
      }).identity
    : null
  const branchBudget = reviewBudgetForBranch(input.database, project, branch, currentRoundIdentity)
  const reviewBudget = reviewRoundBudgetDecision({
    tier: input.tier,
    ...branchBudget,
    roundNeeded: reviewPlan.round.lenses.length > 0 || Boolean(reviewPlan.round.secondOpinion),
  })
  const budgeted = reviewPlanForBudget({
    reviewPlan,
    budget: reviewBudget,
    completedLenses: facts.completedLenses,
    satisfiedSecondOpinionLenses: facts.satisfiedSecondOpinionLenses,
  })
  return {
    ...budgeted,
    reviewBudget: {
      ...reviewBudget,
      eligibleReviewCount: branchBudget.eligibleReviewCount,
      unclassifiableReviewCount: branchBudget.unclassifiableReviewCount,
    },
  }
}
