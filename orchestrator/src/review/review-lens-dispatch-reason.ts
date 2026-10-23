// concern: review-lens-dispatch-reason
/** Computes the funnel selection reason at review-lens dispatch. */

import { db } from '../database/db.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import { roundPlanForReviewTarget } from './review-round-lens-service.ts'
import { resolveReviewTarget } from './review-target.ts'
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
  const plan = roundPlanForReviewTarget({
    database: db(),
    repo: input.cwd,
    project,
    branch: target.branch,
    from: target.base,
    to: target.commit,
  })
  return plan.applicability.lensReasons?.[input.lens] ?? OPERATOR_ORDERED
}
