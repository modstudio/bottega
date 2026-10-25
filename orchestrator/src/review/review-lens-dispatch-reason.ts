// concern: review-lens-dispatch-reason
/** Computes the funnel selection reason at review-lens dispatch. */

import { db } from '../database/db.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import { selectReviewApplicability } from './review-applicability.ts'
import { measureChangeIdentity } from './review-pins.ts'
import { gatherPostFixReviewFacts, postFixReviewDecision } from './review-post-fix.ts'
import { budgetedRoundApplicabilityForChange } from './review-round-lens-service.ts'
import {
  resolveReviewTarget,
  reviewRemoteTrunkRefExists,
  reviewTrunkRef,
  spawnGitProbe,
} from './review-target.ts'
import { reviewTierForRange } from './review-tier-service.ts'
import type { ReviewLensSelectionReason } from './review-vocabulary.ts'

const OPERATOR_ORDERED: ReviewLensSelectionReason = 'operator-ordered'

export function reviewLensSelectionReasonForDispatch(input: {
  jobName: string
  lens: string | undefined
  review: string | undefined
  cwd: string
  repo?: string
}): ReviewLensSelectionReason {
  if (!input.lens) return OPERATOR_ORDERED
  if (input.jobName !== 'review-lens' || !input.review) return OPERATOR_ORDERED
  return funnelReasonForLens({ ...input, lens: input.lens, review: input.review })
}

function funnelReasonForLens(input: {
  lens: string
  review: string
  cwd: string
  repo?: string
}): ReviewLensSelectionReason {
  const project = input.repo ? projectByName(input.repo) : projectAt(input.cwd)
  if (!project) return OPERATOR_ORDERED
  const checkout = input.repo ? project.path : input.cwd
  const target = resolveReviewTarget('review-lens', checkout, input.review)
  if (!target) return OPERATOR_ORDERED
  const identity = measureChangeIdentity(checkout, target.base, target.commit)
  if (!identity) return OPERATOR_ORDERED
  const output = reviewTierForRange(checkout, target.base, target.commit, project.settings.review)
  const trunk = project.settings.trunk?.trim()
  if (!trunk) return OPERATOR_ORDERED
  const postFix = postFixReviewDecision({
    facts: gatherPostFixReviewFacts({
      database: db(),
      repo: checkout,
      to: target.commit,
      trunkRef: reviewTrunkRef(reviewRemoteTrunkRefExists(trunk, spawnGitProbe(checkout)), trunk),
      project: project.name,
      branch: target.branch,
    }),
    tier: output.tier,
    review: project.settings.review,
  })
  const plan = budgetedRoundApplicabilityForChange({
    database: db(),
    group: {
      project: project.name,
      branch: target.branch,
      patchId: identity.patchId,
      pathSet: identity.paths,
    },
    relevant: selectReviewApplicability(output, output.lenses),
    postFix,
    review: project.settings.review,
    tier: output.tier,
  })
  return plan.reviewPlan.round.lensReasons?.[input.lens] ?? OPERATOR_ORDERED
}
