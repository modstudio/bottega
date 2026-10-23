// concern: review-round-lens-service
/** Gathers stored review facts and applies the pure round lens plan. */

import type { Database } from 'bun:sqlite'
import { gitContext } from '../git/git-environment.ts'
import type { ReviewSettings } from '../project/project-injection.ts'
import type { Project } from '../project/projects.ts'
import {
  type ApplicableReview,
  pathScopedLenses,
  selectReviewApplicability,
} from './review-applicability.ts'
import { type ChangeGroup, reviewsForTriage, serializePathSet } from './review-group.ts'
import { measureChangeIdentity } from './review-pins.ts'
import {
  gatherPostFixReviewFacts,
  type PostFixReviewDecision,
  postFixReviewDecision,
} from './review-post-fix.ts'
import { applicableRoundLensPlan, roundLensFacts } from './review-round-lens-plan.ts'
import { reviewRemoteTrunkRefExists, reviewTrunkRef } from './review-target.ts'
import { reviewTierForRange } from './review-tier-service.ts'

/** Assemble the round plan from the current change, branch review history, and project declaration. */
function roundApplicabilityForChange(input: {
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

/** Resolve one review target into the shared tier, identity, post-fix, and funnel plan. */
export function roundPlanForReviewTarget(input: {
  database: Database
  repo: string
  project: Project
  branch: string
  from: string
  to: string
}) {
  const trunk = input.project.settings.trunk?.trim()
  if (!trunk) throw new Error(`project ${input.project.name} has no trunk configured`)
  const output = reviewTierForRange(input.repo, input.from, input.to, input.project.settings.review)
  const identity = measureChangeIdentity(input.repo, input.from, input.to)
  const relevant = selectReviewApplicability(output, output.lenses)
  const postFix = postFixReviewDecision({
    facts: gatherPostFixReviewFacts({
      database: input.database,
      repo: input.repo,
      from: input.from,
      to: input.to,
      trunkRef: reviewTrunkRef(
        reviewRemoteTrunkRefExists(trunk, (args) => gitContext(input.repo, ...args) !== null),
        trunk,
      ),
      project: input.project.name,
      branch: input.branch,
    }),
    tier: output.tier,
    review: input.project.settings.review,
  })
  const group = identity
    ? {
        project: input.project.name,
        branch: input.branch,
        patchId: identity.patchId,
        pathSet: identity.paths,
      }
    : null
  return {
    output,
    identity,
    group,
    postFix,
    applicability: group
      ? roundApplicabilityForChange({
          database: input.database,
          group,
          relevant,
          postFix,
          review: input.project.settings.review,
        })
      : relevant,
  }
}
