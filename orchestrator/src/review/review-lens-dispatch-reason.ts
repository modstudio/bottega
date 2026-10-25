// concern: review-lens-dispatch-reason
/** Computes the funnel selection reason at review-lens dispatch. */

import { db } from '../database/db.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import { budgetedReviewPlanForResolvedChange } from './review-round-lens-service.ts'
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
  const checkout = input.repo ? project.path : input.cwd
  const target = resolveReviewTarget('review-lens', checkout, input.review)
  if (!target) return OPERATOR_ORDERED
  const trunk = project.settings.trunk?.trim()
  if (!trunk) return OPERATOR_ORDERED
  const plan = budgetedReviewPlanForResolvedChange({
    database: db(),
    cwd: checkout,
    base: target.base,
    commit: target.commit,
    branch: target.branch,
    project,
  })
  if (!plan.identity) return OPERATOR_ORDERED
  return plan.reviewPlan.round.lensReasons?.[input.lens] ?? OPERATOR_ORDERED
}
