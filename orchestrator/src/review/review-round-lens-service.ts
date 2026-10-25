// concern: review-round-lens-service
/** Gathers stored review facts and applies the pure round lens plan. */

import type { Database } from 'bun:sqlite'
import type { ReviewSettings } from '../project/project-injection.ts'
import type { Project } from '../project/projects.ts'
import {
  type ApplicableReview,
  lensesSelectingPaths,
  type ReviewFunnelPlan,
  selectReviewApplicability,
} from './review-applicability.ts'
import { type ChangeGroup, reviewsForTriage, serializePathSet } from './review-group.ts'
import { measureChangeIdentity } from './review-pins.ts'
import {
  gatherPostFixReviewFacts,
  type PostFixReviewDecision,
  postFixReviewDecision,
} from './review-post-fix.ts'
import {
  currentReviewRoundIdentity,
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
import { reviewRemoteTrunkRefExists, reviewTrunkRef, spawnGitProbe } from './review-target.ts'
import { reviewTierForRange } from './review-tier-service.ts'

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
    ? currentReviewRoundIdentity({
        branch,
        patchId: input.group.patchId,
        pathSet: serializePathSet(input.group.pathSet),
      })
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

/** Gather tier, identity, post-fix history, and the budgeted funnel for a resolved change once. */
export function budgetedReviewPlanForResolvedChange(input: {
  database: Database
  cwd: string
  base: string
  commit: string
  branch: string
  project: Project
}) {
  const review = input.project.settings.review
  const output = reviewTierForRange(input.cwd, input.base, input.commit, review)
  const identity = measureChangeIdentity(input.cwd, input.base, input.commit)
  const trunk = input.project.settings.trunk?.trim()
  if (!trunk) throw new Error(`project ${input.project.name} has no trunk configured`)
  const postFix = postFixReviewDecision({
    facts: gatherPostFixReviewFacts({
      database: input.database,
      repo: input.cwd,
      to: input.commit,
      trunkRef: reviewTrunkRef(reviewRemoteTrunkRefExists(trunk, spawnGitProbe(input.cwd)), trunk),
      project: input.project.name,
      branch: input.branch,
    }),
    tier: output.tier,
    review,
  })
  const relevant = selectReviewApplicability(output, output.lenses)
  const plan = identity
    ? budgetedRoundApplicabilityForChange({
        database: input.database,
        group: {
          project: input.project.name,
          branch: input.branch,
          patchId: identity.patchId,
          pathSet: identity.paths,
        },
        relevant,
        postFix,
        review,
        tier: output.tier,
      })
    : budgetedRoundApplicabilityForChange({
        database: input.database,
        project: input.project.name,
        branch: input.branch,
        relevant,
        tier: output.tier,
      })
  return { output, identity, postFix, ...plan }
}
