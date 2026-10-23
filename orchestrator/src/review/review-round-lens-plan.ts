// concern: review-round-lens-plan
/** Decides which relevant lenses belong in one review round. */

import {
  type ApplicableReview,
  type ReviewFunnelPlan,
  selectReviewApplicability,
} from './review-applicability.ts'
import type { TriageReviewRow } from './review-group.ts'
import type { PostFixReviewDecision } from './review-post-fix.ts'
import { identifySecondOpinionRun } from './review-second-opinion.ts'

export type RoundLensFacts = {
  reviewedPathsByLens: Readonly<Record<string, readonly string[]>>
  completedLenses: readonly string[]
  satisfiedSecondOpinionLenses: readonly string[]
  latestAcceptedOrModifiedLenses: readonly string[]
}

/**
 * The later-round review funnel: re-run lenses whose latest-round findings were accepted or
 * modified and path-scoped lenses selected by paths they have never reviewed on the branch.
 */
export function roundLensPlan(input: {
  relevantLenses: readonly string[]
  latestAcceptedOrModifiedLenses: readonly string[]
  newlyTouchedLenses: readonly string[]
}): string[] {
  const findings = new Set(input.latestAcceptedOrModifiedLenses)
  const newlyTouched = new Set(input.newlyTouchedLenses)
  return input.relevantLenses.filter((lens) => findings.has(lens) || newlyTouched.has(lens))
}

/** Gather branch-history facts without deciding which lenses the round needs. */
export function roundLensFacts(
  branchReviews: readonly TriageReviewRow[],
  current: { patchId: string; pathSet: string },
): RoundLensFacts {
  const completedLenses = [
    ...new Set(
      branchReviews
        .filter((review) => review.completedAt !== null && review.tier !== null)
        .flatMap((review) => review.lensIdentities),
    ),
  ]
  const completedOpinions = branchReviews.flatMap((review) =>
    review.lenses.flatMap((opinion) =>
      opinion.runId && opinion.lens
        ? [
            {
              recordId: opinion.recordId,
              runId: opinion.runId,
              lens: opinion.lens,
              model: opinion.model ?? null,
              graded: opinion.graded,
              completed: review.completedAt !== null,
            },
          ]
        : [],
    ),
  )
  const satisfiedSecondOpinionLenses = completedLenses.filter((lens) =>
    Boolean(identifySecondOpinionRun(completedOpinions, lens)),
  )
  const prior = branchReviews.filter(
    (review) =>
      review.completedAt !== null &&
      review.tier !== null &&
      (review.patchId !== current.patchId || review.pathSet !== current.pathSet),
  )
  prior.sort((left, right) => right.reviewNumber - left.reviewNumber)
  const reviewedPathsByLens: Record<string, string[]> = {}
  for (const review of prior) {
    const paths = review.pathSet ? (JSON.parse(review.pathSet) as string[]) : []
    for (const lens of review.lensIdentities) {
      reviewedPathsByLens[lens] = [...new Set([...(reviewedPathsByLens[lens] ?? []), ...paths])]
    }
  }
  const latest = prior[0]
  if (!latest)
    return {
      reviewedPathsByLens,
      completedLenses,
      satisfiedSecondOpinionLenses,
      latestAcceptedOrModifiedLenses: [],
    }
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
  return {
    reviewedPathsByLens,
    completedLenses,
    satisfiedSecondOpinionLenses,
    latestAcceptedOrModifiedLenses,
  }
}

function newlyTouchedLenses(input: {
  relevant: ApplicableReview
  facts: RoundLensFacts
  fixPathsByLens: Readonly<Record<string, readonly string[]>>
}): string[] {
  return input.relevant.lenses.filter((lens) => {
    const reviewed = new Set(input.facts.reviewedPathsByLens[lens] ?? [])
    return (input.fixPathsByLens[lens] ?? []).some((path) => !reviewed.has(path))
  })
}

/** Apply the funnel to the repository decision about whether a later round is needed. */
export function applicableRoundLensPlan(input: {
  relevant: ApplicableReview
  facts: RoundLensFacts
  postFix: PostFixReviewDecision
  fixPathsByLens: Readonly<Record<string, readonly string[]>>
}): ReviewFunnelPlan {
  const round = (() => {
    if (input.postFix.kind === 'no-completed-round') return input.relevant
    if (input.postFix.kind === 'no-round-needed')
      return selectReviewApplicability(input.relevant, [])
    const newlyTouched =
      input.postFix.kind === 're-lens'
        ? newlyTouchedLenses({
            relevant: input.relevant,
            facts: input.facts,
            fixPathsByLens: input.fixPathsByLens,
          })
        : []
    return selectReviewApplicability(
      input.relevant,
      roundLensPlan({
        relevantLenses: input.relevant.lenses,
        latestAcceptedOrModifiedLenses: input.facts.latestAcceptedOrModifiedLenses,
        newlyTouchedLenses: newlyTouched,
      }),
    )
  })()
  const required = new Set([...input.facts.completedLenses, ...round.lenses])
  const admissionLenses = [
    ...input.relevant.lenses.filter((lens) => required.has(lens)),
    ...input.facts.completedLenses.filter((lens) => !input.relevant.lenses.includes(lens)),
  ]
  const secondOpinionOwed =
    input.relevant.secondOpinion &&
    required.has(input.relevant.secondOpinion) &&
    !input.facts.satisfiedSecondOpinionLenses.includes(input.relevant.secondOpinion)
  const roundWithOpinion = secondOpinionOwed
    ? {
        ...round,
        secondOpinion: input.relevant.secondOpinion,
        ...(input.relevant.secondOpinionBasis
          ? { secondOpinionBasis: input.relevant.secondOpinionBasis }
          : {}),
      }
    : round
  return {
    round: roundWithOpinion,
    admissionRequired: selectReviewApplicability(input.relevant, admissionLenses),
  }
}
