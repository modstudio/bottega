// concern: review-lens-dispatch-reason
/** Computes the funnel selection reason at review-lens dispatch. */

import { db } from '../database/db.ts'
import { gitContext } from '../git/git-environment.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import type { ApplicableReview } from './review-applicability.ts'
import { measureChangeIdentity } from './review-pins.ts'
import { gatherPostFixReviewFacts, postFixReviewDecision } from './review-post-fix.ts'
import { roundApplicabilityForChange } from './review-round-lens-service.ts'
import { resolveReviewTarget, reviewRemoteTrunkRefExists, reviewTrunkRef } from './review-target.ts'
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
  const target = resolveReviewTarget('review-lens', input.cwd, input.review)
  if (!target) return OPERATOR_ORDERED
  const trunk = project.settings.trunk?.trim()
  if (!trunk) return OPERATOR_ORDERED
  const remoteTrackingRefExists = reviewRemoteTrunkRefExists(
    trunk,
    (args) => gitContext(input.cwd, ...args) !== null,
  )
  const output = reviewTierForRange(input.cwd, target.base, target.commit, project.settings.review)
  const identity = measureChangeIdentity(input.cwd, target.base, target.commit)
  if (!identity) return OPERATOR_ORDERED
  const postFix = postFixReviewDecision({
    facts: gatherPostFixReviewFacts({
      database: db(),
      repo: input.cwd,
      from: target.base,
      to: target.commit,
      trunkRef: reviewTrunkRef(remoteTrackingRefExists, trunk),
      project: project.name,
      branch: target.branch,
    }),
    tier: output.tier,
    review: project.settings.review,
  })
  const relevant: ApplicableReview = {
    lenses: output.lenses,
    secondOpinion: output.secondOpinion,
    lensBases: output.lensBases,
    secondOpinionBasis: output.secondOpinionBasis,
  }
  const plan = roundApplicabilityForChange({
    database: db(),
    group: {
      project: project.name,
      branch: target.branch,
      patchId: identity.patchId,
      pathSet: identity.paths,
    },
    relevant,
    postFix,
    review: project.settings.review,
  })
  return plan.lensReasons?.[input.lens] ?? OPERATOR_ORDERED
}
