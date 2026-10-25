// concern: review-round-lens-plan
/** Decides which relevant lenses belong in one review round. */

import {
  type ApplicableReview,
  type ReviewFunnelPlan,
  selectReviewApplicability,
} from './review-applicability.ts'
import type { TriageReviewRow } from './review-group.ts'
import type { PostFixReviewDecision } from './review-post-fix.ts'
import { reviewCountsAsRound } from './review-role.ts'
import type { ReviewRoundBudgetDecision } from './review-round-budget.ts'
import { identifySecondOpinionRun } from './review-second-opinion.ts'
import type { ReviewLensSelectionReason } from './review-vocabulary.ts'

export type RoundLensFacts = {
  reviewedPathsByLens: Readonly<Record<string, readonly string[]>>
  completedLenses: readonly string[]
  satisfiedSecondOpinionLenses: readonly string[]
  latestAcceptedOrModifiedLenses: readonly string[]
}

/** Return the review round that the budget permits to run. */
export function reviewRoundForBudget(
  round: ApplicableReview,
  budget: ReviewRoundBudgetDecision,
): ApplicableReview {
  return budget.wouldExceedCeiling ? selectReviewApplicability(round, []) : round
}

export type BudgetedReviewPlanDecision = {
  reviewPlan: ReviewFunnelPlan
  creditedByArchitectRead: ApplicableReview
}

/** Apply the round ceiling to both work dispatched and exact-tip admission evidence. */
export function reviewPlanForBudget(input: {
  reviewPlan: ReviewFunnelPlan
  budget: ReviewRoundBudgetDecision
  completedLenses: readonly string[]
  satisfiedSecondOpinionLenses: readonly string[]
}): BudgetedReviewPlanDecision {
  if (!input.budget.wouldExceedCeiling) {
    return {
      reviewPlan: input.reviewPlan,
      creditedByArchitectRead: { lenses: [] },
    }
  }
  const credited = input.reviewPlan.round
  const creditedLenses = new Set(credited.lenses)
  const completed = new Set(input.completedLenses)
  const admissionLenses = input.reviewPlan.admissionRequired.lenses.filter(
    (lens) => !creditedLenses.has(lens) || completed.has(lens),
  )
  const admissionRequired = selectReviewApplicability(
    input.reviewPlan.admissionRequired,
    admissionLenses,
  )
  const creditedOwedSecondOpinion =
    credited.secondOpinion !== undefined &&
    !input.satisfiedSecondOpinionLenses.includes(credited.secondOpinion)
  if (creditedOwedSecondOpinion) {
    delete admissionRequired.secondOpinion
    delete admissionRequired.secondOpinionBasis
  }
  const round = reviewRoundForBudget(input.reviewPlan.round, input.budget)
  const newlyTouchedPaths = newlyTouchedPathsForRound(
    input.reviewPlan.newlyTouchedPathsByLens,
    round.lenses,
  )
  return {
    reviewPlan: {
      round,
      admissionRequired,
      ...(input.reviewPlan.completedLensesOnBranch?.length
        ? { completedLensesOnBranch: input.reviewPlan.completedLensesOnBranch }
        : {}),
      ...(Object.keys(newlyTouchedPaths).length
        ? { newlyTouchedPathsByLens: newlyTouchedPaths }
        : {}),
    },
    creditedByArchitectRead: credited,
  }
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

function laterRoundReason(
  lens: string,
  findings: ReadonlySet<string>,
  newlyTouched: ReadonlySet<string>,
): ReviewLensSelectionReason | null {
  if (findings.has(lens)) return 'accepted-finding'
  if (newlyTouched.has(lens)) return 'newly-touched-path'
  return null
}

function withLensReasons(
  applicable: ApplicableReview,
  reasons: Record<string, ReviewLensSelectionReason>,
): ApplicableReview {
  return Object.keys(reasons).length ? { ...applicable, lensReasons: reasons } : applicable
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
      reviewCountsAsRound(review.role) &&
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

/** Per lens, the fix paths that select it and that it has never reviewed on the branch. */
function newlyTouchedPathsByLens(input: {
  relevant: ApplicableReview
  facts: RoundLensFacts
  fixPathsByLens: Readonly<Record<string, readonly string[]>>
}): Record<string, string[]> {
  const touched: Record<string, string[]> = {}
  for (const lens of input.relevant.lenses) {
    const reviewed = new Set(input.facts.reviewedPathsByLens[lens] ?? [])
    const paths = (input.fixPathsByLens[lens] ?? []).filter((path) => !reviewed.has(path))
    if (paths.length) touched[lens] = paths
  }
  return touched
}

/** The newly-touched facts for the lenses the budgeted round still asks for. */
function newlyTouchedPathsForRound(
  pathsByLens: Readonly<Record<string, string[]>> | undefined,
  lenses: readonly string[],
): Record<string, string[]> {
  const selected = new Set(lenses)
  return Object.fromEntries(
    Object.entries(pathsByLens ?? {}).filter(([lens]) => selected.has(lens)),
  )
}

/** Apply the funnel to the repository decision about whether a later round is needed. */
export function applicableRoundLensPlan(input: {
  relevant: ApplicableReview
  facts: RoundLensFacts
  postFix: PostFixReviewDecision
  fixPathsByLens: Readonly<Record<string, readonly string[]>>
}): ReviewFunnelPlan {
  const newlyTouched =
    input.postFix.kind === 're-lens'
      ? newlyTouchedPathsByLens({
          relevant: input.relevant,
          facts: input.facts,
          fixPathsByLens: input.fixPathsByLens,
        })
      : {}
  const round = (() => {
    if (input.postFix.kind === 'no-completed-round')
      return withLensReasons(
        input.relevant,
        Object.fromEntries(input.relevant.lenses.map((lens) => [lens, 'initial'])),
      )
    if (input.postFix.kind === 'no-round-needed')
      return selectReviewApplicability(input.relevant, [])
    const touchedLenses = Object.keys(newlyTouched)
    const lenses = roundLensPlan({
      relevantLenses: input.relevant.lenses,
      latestAcceptedOrModifiedLenses: input.facts.latestAcceptedOrModifiedLenses,
      newlyTouchedLenses: touchedLenses,
    })
    const findings = new Set(input.facts.latestAcceptedOrModifiedLenses)
    const touched = new Set(touchedLenses)
    const unidentified = input.postFix.kind === 'reviewed-tip-unidentified'
    return withLensReasons(
      selectReviewApplicability(input.relevant, lenses),
      Object.fromEntries(
        lenses
          .map((lens) => [
            lens,
            unidentified ? 'unidentified-tip-funnel' : laterRoundReason(lens, findings, touched),
          ])
          .filter((entry): entry is [string, ReviewLensSelectionReason] => entry[1] !== null),
      ),
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
  const newlyTouchedForRound = newlyTouchedPathsForRound(newlyTouched, roundWithOpinion.lenses)
  return {
    round: roundWithOpinion,
    admissionRequired: selectReviewApplicability(input.relevant, admissionLenses),
    ...(input.facts.completedLenses.length
      ? { completedLensesOnBranch: [...input.facts.completedLenses] }
      : {}),
    ...(Object.keys(newlyTouchedForRound).length
      ? { newlyTouchedPathsByLens: newlyTouchedForRound }
      : {}),
  }
}
