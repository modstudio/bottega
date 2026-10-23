// concern: review-round-lens-plan
/** Decides which relevant lenses belong in one review round. */

import { type ApplicableReview, selectReviewApplicability } from './review-applicability.ts'
import type { TriageReviewRow } from './review-group.ts'
import type { PostFixReviewDecision } from './review-post-fix.ts'

export type RoundLensFacts = {
  completedLenses: readonly string[]
  latestAcceptedOrModifiedLenses: readonly string[]
}

/**
 * The review funnel: an initial round runs every relevant lens; a later round runs lenses
 * never completed on the branch, lenses whose latest-round findings were accepted or modified,
 * and lenses selected by paths newly touched in the fix. An unidentified reviewed tip still
 * uses this funnel; the full relevant set is not the fallback.
 */
export function roundLensPlan(input: {
  relevantLenses: readonly string[]
  completedLenses: readonly string[]
  latestAcceptedOrModifiedLenses: readonly string[]
  newlyTouchedLenses: readonly string[]
}): string[] {
  const completed = new Set(input.completedLenses)
  const findings = new Set(input.latestAcceptedOrModifiedLenses)
  const newlyTouched = new Set(input.newlyTouchedLenses)
  return input.relevantLenses.filter(
    (lens) => !completed.has(lens) || findings.has(lens) || newlyTouched.has(lens),
  )
}

/** Gather branch-history facts without deciding which lenses the round needs. */
export function roundLensFacts(
  branchReviews: readonly TriageReviewRow[],
  current: { patchId: string; pathSet: string },
): RoundLensFacts {
  const prior = branchReviews.filter(
    (review) =>
      review.completedAt !== null &&
      review.tier !== null &&
      (review.patchId !== current.patchId || review.pathSet !== current.pathSet),
  )
  prior.sort((left, right) => right.reviewNumber - left.reviewNumber)
  const completedLenses = [...new Set(prior.flatMap((review) => review.lensIdentities))]
  const latest = prior[0]
  if (!latest) return { completedLenses, latestAcceptedOrModifiedLenses: [] }
  const latestRound = prior.filter(
    (review) => review.patchId === latest.patchId && review.pathSet === latest.pathSet,
  )
  const latestAcceptedOrModifiedLenses = [
    ...new Set(
      latestRound.flatMap((review) =>
        review.findings
          .filter(({ disposition }) => disposition === 'accepted' || disposition === 'modified')
          .flatMap(({ lens }) => (lens ? [lens] : [])),
      ),
    ),
  ]
  return { completedLenses, latestAcceptedOrModifiedLenses }
}

/** Apply the funnel to the repository decision about whether a later round is needed. */
export function applicableRoundLensPlan(input: {
  relevant: ApplicableReview
  facts: RoundLensFacts
  postFix: PostFixReviewDecision
  pathScopedLenses: readonly string[]
}): ApplicableReview {
  if (input.postFix.kind === 'no-completed-round') return input.relevant
  if (input.postFix.kind === 'no-round-needed') {
    const completed = new Set(input.facts.completedLenses)
    return selectReviewApplicability(
      input.relevant,
      input.relevant.lenses.filter((lens) => !completed.has(lens)),
    )
  }
  const pathScoped = new Set(input.pathScopedLenses)
  const newlyTouchedLenses =
    input.postFix.kind === 're-lens'
      ? input.postFix.applicability.lenses.filter((lens) => pathScoped.has(lens))
      : []
  return selectReviewApplicability(
    input.relevant,
    roundLensPlan({
      relevantLenses: input.relevant.lenses,
      completedLenses: input.facts.completedLenses,
      latestAcceptedOrModifiedLenses: input.facts.latestAcceptedOrModifiedLenses,
      newlyTouchedLenses,
    }),
  )
}
