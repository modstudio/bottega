// concern: pull-request-triage-decision
/** Decides whether recorded review evidence admits one exact change group. */

import type { ApplicableReview } from '../review/review-applicability.ts'
import type { TriageReviewRow } from '../review/review-group.ts'
import { identifySecondOpinionRun } from '../review/review-second-opinion.ts'

export type TriageReviewGroup = {
  reviews: readonly TriageReviewRow[]
}

export type TriageEvidence = {
  patchId: string
  pathSet: string
  tip: string
  tier: 0 | 1 | 2 | 3
  applicableReview: ApplicableReview
  roundReview?: ApplicableReview
  branchOwnerSession: string | null
  reviews: readonly TriageReviewRow[]
  branchReviewGroups: readonly TriageReviewGroup[]
  reads: readonly {
    recordId: string
    tip: string
    patchId: string
    pathSet: string
    recordedAt: string
    sessionId: string | null
  }[]
}

type TriageSnapshot = {
  reviewRecordIds: string[]
  patchId: string
  tier: 0 | 1 | 2 | 3
  lensRounds: number
  findingCount: number
  admissionPath: 'exact_review' | 'architect_read'
  readRecordId: string | null
}

export type TriageDecision =
  | { complete: true; snapshot: TriageSnapshot }
  | {
      complete: false
      snapshot: TriageSnapshot
      missingReview: boolean
      unfinishedReviewNumbers: number[]
      undisposedFindings: { reviewNumber: number; ordinal: number }[]
      missingLenses: { lens: string; recordedOnBranch: boolean }[]
      missingSecondOpinion: { lens: string; firstRunId: string | null } | null
      architectReadRequired: boolean
      earlierReviewNumber: number | null
      earlierReviewTier: 0 | 1 | 2 | 3 | null
      finalTierRaised: boolean
      noCompleteReviewRound: boolean
    }

/** The lens coverage still required by an incomplete triage decision. */
export function missingLensNames(decision: TriageDecision): string[] {
  if (decision.complete) return []
  return [
    ...new Set([
      ...decision.missingLenses.map(({ lens }) => lens),
      ...(decision.missingSecondOpinion ? [decision.missingSecondOpinion.lens] : []),
    ]),
  ].sort()
}

type CompleteReviewRound = {
  reviews: readonly TriageReviewRow[]
  tier: 0 | 1 | 2 | 3
  completedAt: string
}

type ReviewGaps = {
  missingLenses: { lens: string; recordedOnBranch: boolean }[]
  undisposedFindings: { reviewNumber: number; ordinal: number }[]
  missingSecondOpinion: { lens: string; firstRunId: string | null } | null
}

type ComposedReviewEvidence = {
  coverageGaps: ReviewGaps
  round: CompleteReviewRound | null
}

function recordedLensRounds(reviews: readonly TriageReviewRow[]): number {
  return reviews.reduce((count, review) => count + review.lenses.length, 0)
}

export type SecondOpinionDecision =
  | { complete: true }
  | { complete: false; lens: string; firstRunId: string | null }

type SecondOpinionSelection =
  | { complete: true; credited: readonly TriageReviewRow[] }
  | { complete: false; lens: string; firstRunId: string | null }

/**
 * The one rule for a second opinion: two completed, graded runs of the lens with distinct
 * recorded effective models. A complete selection names the reviews holding the two credited
 * runs, the earliest run with a model and the earliest with a different one.
 */
function selectSecondOpinion(
  reviews: readonly TriageReviewRow[],
  lens: string,
): SecondOpinionSelection {
  const opinions = reviews
    .flatMap((review) => review.lenses.map((opinion) => ({ opinion, review })))
    .sort((left, right) => left.opinion.recordId.localeCompare(right.opinion.recordId))
  const creditedRuns = identifySecondOpinionRun(
    opinions.flatMap(({ opinion, review }) =>
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
    lens,
  )
  const eligible = opinions.filter(
    ({ opinion, review }) => review.completedAt !== null && opinion.graded && opinion.lens === lens,
  )
  const first = eligible.find(({ opinion }) => opinion.runId === creditedRuns?.firstRunId)
  const second = eligible.find(({ opinion }) => opinion.runId === creditedRuns?.secondRunId)
  if (!first || !second) {
    return { complete: false, lens, firstRunId: eligible[0]?.opinion.runId ?? null }
  }
  return {
    complete: true,
    credited: [
      ...new Map(
        [first.review, second.review].map((review) => [review.reviewRecordId, review]),
      ).values(),
    ],
  }
}

/** Whether the lens's second opinion is satisfied, and if not, which run asks for one. */
export function decideSecondOpinion(
  reviews: readonly TriageReviewRow[],
  lens: string | undefined,
): SecondOpinionDecision {
  if (!lens) return { complete: true }
  const selection = selectSecondOpinion(reviews, lens)
  return selection.complete ? { complete: true } : selection
}

function undisposedReviewFindings(review: TriageReviewRow) {
  return review.findings
    .filter(({ disposition }) => disposition === null)
    .map(({ ordinal }) => ({ reviewNumber: review.reviewNumber, ordinal }))
}

function coverApplicableLens(
  lens: string,
  exactRequired: ReadonlySet<string>,
  exactCompleted: readonly TriageReviewRow[],
  completed: readonly TriageReviewRow[],
): { kind: 'covered'; review: TriageReviewRow } | { kind: 'missing'; recordedOnBranch: boolean } {
  const latest = (exactRequired.has(lens) ? exactCompleted : completed).find((review) =>
    review.lensIdentities.includes(lens),
  )
  if (latest && latest.tier !== null) return { kind: 'covered', review: latest }
  return {
    kind: 'missing',
    recordedOnBranch: completed.some(
      (review) => review.lensIdentities.includes(lens) && review.tier !== null,
    ),
  }
}

function composedReviewEvidence(
  branchReviewGroups: readonly TriageReviewGroup[],
  applicableReview: ApplicableReview,
  exactReviews: readonly TriageReviewRow[] = [],
  roundReview: ApplicableReview = applicableReview,
): ComposedReviewEvidence {
  const branchReviews = branchReviewGroups.flatMap(({ reviews }) => reviews)
  const completed = branchReviews
    .filter((review) => review.completedAt !== null)
    .sort((left, right) => right.completedAt!.localeCompare(left.completedAt!))
  const selected = new Map<string, TriageReviewRow>()
  const missingLenses: ReviewGaps['missingLenses'] = []
  const undisposedFindings: { reviewNumber: number; ordinal: number }[] = []
  const exactCompleted = exactReviews
    .filter((review) => review.completedAt !== null)
    .sort((left, right) => right.completedAt!.localeCompare(left.completedAt!))
  const exactRequired = new Set(roundReview.lenses)
  for (const lens of applicableReview.lenses) {
    const coverage = coverApplicableLens(lens, exactRequired, exactCompleted, completed)
    if (coverage.kind === 'missing') {
      missingLenses.push({ lens, recordedOnBranch: coverage.recordedOnBranch })
      continue
    }
    const untriaged = undisposedReviewFindings(coverage.review)
    if (untriaged.length) {
      undisposedFindings.push(...untriaged)
    }
    selected.set(coverage.review.reviewRecordId, coverage.review)
  }
  const selectedReviews = [...selected.values()]
  const secondOpinionPool =
    roundReview.secondOpinion === applicableReview.secondOpinion ? exactCompleted : completed
  const secondOpinionReviews = applicableReview.secondOpinion
    ? secondOpinionPool.filter((review) =>
        review.lensIdentities.includes(applicableReview.secondOpinion!),
      )
    : []
  const opinionSelection = applicableReview.secondOpinion
    ? selectSecondOpinion(
        [
          ...new Map(
            [...selectedReviews, ...secondOpinionReviews].map((review) => [
              review.reviewRecordId,
              review,
            ]),
          ).values(),
        ],
        applicableReview.secondOpinion,
      )
    : ({ complete: true, credited: [] } as const)
  const missingSecondOpinion = opinionSelection.complete
    ? null
    : { lens: opinionSelection.lens, firstRunId: opinionSelection.firstRunId }
  const opinionReviews = opinionSelection.complete ? opinionSelection.credited : []
  undisposedFindings.push(...opinionReviews.flatMap((review) => undisposedReviewFindings(review)))
  const reviews = [
    ...new Map(
      [...selectedReviews, ...opinionReviews].map((review) => [review.reviewRecordId, review]),
    ).values(),
  ]
  const sortedUndisposed = [
    ...new Map(
      undisposedFindings.map((finding) => [`${finding.reviewNumber}/${finding.ordinal}`, finding]),
    ).values(),
  ].sort((a, b) => a.reviewNumber - b.reviewNumber || a.ordinal - b.ordinal)
  const complete =
    reviews.length > 0 &&
    missingLenses.length === 0 &&
    sortedUndisposed.length === 0 &&
    missingSecondOpinion === null
  return {
    round: complete
      ? {
          reviews,
          tier: Math.max(...reviews.map((review) => review.tier!)) as 0 | 1 | 2 | 3,
          completedAt: reviews
            .map((review) => review.completedAt!)
            .sort((left, right) => right.localeCompare(left))[0]!,
        }
      : null,
    coverageGaps: {
      missingLenses,
      undisposedFindings: sortedUndisposed,
      missingSecondOpinion,
    },
  }
}

function architectReadSnapshot(
  evidence: TriageEvidence,
  round: CompleteReviewRound,
  readRecordId: string,
): TriageSnapshot {
  return {
    reviewRecordIds: round.reviews.map((review) => review.reviewRecordId).sort(),
    patchId: evidence.patchId,
    tier: evidence.tier,
    lensRounds: recordedLensRounds(round.reviews),
    findingCount: round.reviews.flatMap((review) => review.findings).length,
    admissionPath: 'architect_read',
    readRecordId,
  }
}

function exactReviewEvidence(evidence: TriageEvidence) {
  const reviewRecordIds = [...new Set(evidence.reviews.map((row) => row.reviewRecordId))].sort()
  const findings = evidence.reviews.flatMap((review) =>
    review.findings.map((finding) => ({ ...finding, reviewNumber: review.reviewNumber })),
  )
  const judgedLenses = new Set(
    evidence.reviews
      .filter((review) => review.completedAt !== null)
      .flatMap((review) => review.lensIdentities),
  )
  const secondOpinion = decideSecondOpinion(
    evidence.reviews,
    evidence.applicableReview.secondOpinion,
  )
  const currentPatch = {
    unfinishedReviewNumbers: evidence.reviews
      .filter((row) => row.completedAt === null)
      .map((row) => row.reviewNumber)
      .sort((left, right) => left - right),
    undisposedFindings: evidence.reviews
      .flatMap(undisposedReviewFindings)
      .sort((a, b) => a.reviewNumber - b.reviewNumber || a.ordinal - b.ordinal),
  }
  const coverageGaps: ReviewGaps = {
    undisposedFindings: [],
    missingLenses: evidence.applicableReview.lenses
      .filter((lens) => !judgedLenses.has(lens))
      .map((lens) => ({ lens, recordedOnBranch: false })),
    missingSecondOpinion: secondOpinion.complete
      ? null
      : { lens: secondOpinion.lens, firstRunId: secondOpinion.firstRunId },
  }
  return {
    snapshot: {
      reviewRecordIds,
      patchId: evidence.patchId,
      tier: evidence.tier,
      lensRounds: recordedLensRounds(evidence.reviews),
      findingCount: findings.length,
      admissionPath: 'exact_review' as const,
      readRecordId: null,
    },
    missingReview: evidence.applicableReview.lenses.length > 0 && reviewRecordIds.length === 0,
    currentPatch,
    coverageGaps,
  }
}

function incompleteTriageDecision(input: {
  exact: ReturnType<typeof exactReviewEvidence>
  composed: ComposedReviewEvidence
  earlierRound: CompleteReviewRound | null
  exactRead: TriageEvidence['reads'][number] | undefined
  finalTierRaised: boolean
  hasCompletedBranchReview: boolean
}): Exclude<TriageDecision, { complete: true }> {
  const { exact, composed, earlierRound, exactRead, finalTierRaised, hasCompletedBranchReview } =
    input
  const emptyGaps: ReviewGaps = {
    missingLenses: [],
    undisposedFindings: [],
    missingSecondOpinion: null,
  }
  const coverageGaps =
    earlierRound && !finalTierRaised
      ? emptyGaps
      : hasCompletedBranchReview
        ? composed.coverageGaps
        : exact.coverageGaps
  const missingReview =
    (earlierRound && !finalTierRaised) || hasCompletedBranchReview ? false : exact.missingReview
  const undisposedFindings = [
    ...new Map(
      [...exact.currentPatch.undisposedFindings, ...coverageGaps.undisposedFindings].map(
        (finding) => [`${finding.reviewNumber}/${finding.ordinal}`, finding],
      ),
    ).values(),
  ].sort((a, b) => a.reviewNumber - b.reviewNumber || a.ordinal - b.ordinal)
  return {
    complete: false,
    snapshot: exact.snapshot,
    missingReview,
    unfinishedReviewNumbers: exact.currentPatch.unfinishedReviewNumbers,
    undisposedFindings,
    missingLenses: coverageGaps.missingLenses,
    missingSecondOpinion: coverageGaps.missingSecondOpinion,
    architectReadRequired: Boolean(earlierRound && !finalTierRaised && !exactRead),
    earlierReviewNumber: earlierRound?.reviews[0]?.reviewNumber ?? null,
    earlierReviewTier: earlierRound?.tier ?? null,
    finalTierRaised,
    noCompleteReviewRound:
      !earlierRound &&
      !missingReview &&
      coverageGaps.missingLenses.length === 0 &&
      undisposedFindings.length === 0 &&
      coverageGaps.missingSecondOpinion === null,
  }
}

/** One pure decision over the already-selected rows for a patch/path change group. */
export function decideTriage(evidence: TriageEvidence): TriageDecision {
  const exactReview = evidence.roundReview ?? evidence.applicableReview
  const creditedRoundReview = evidence.roundReview ?? { lenses: [] }
  const exact = exactReviewEvidence({ ...evidence, applicableReview: exactReview })
  if (
    exactReview.lenses.length === evidence.applicableReview.lenses.length &&
    evidence.applicableReview.lenses.every((lens) => exactReview.lenses.includes(lens)) &&
    !exact.missingReview &&
    !exact.currentPatch.unfinishedReviewNumbers.length &&
    !exact.currentPatch.undisposedFindings.length &&
    !exact.coverageGaps.missingLenses.length &&
    exact.coverageGaps.missingSecondOpinion === null
  ) {
    return { complete: true, snapshot: exact.snapshot }
  }
  const composed = composedReviewEvidence(
    evidence.branchReviewGroups,
    evidence.applicableReview,
    evidence.reviews,
    creditedRoundReview,
  )
  const earlierRound = composed.round
  const hasCompletedBranchReview = evidence.branchReviewGroups.some(({ reviews }) =>
    reviews.some(({ completedAt }) => completedAt !== null),
  )
  const exactRead = earlierRound
    ? evidence.reads.find(
        (read) =>
          read.tip === evidence.tip &&
          read.patchId === evidence.patchId &&
          read.pathSet === evidence.pathSet &&
          read.recordedAt > earlierRound.completedAt &&
          read.sessionId === evidence.branchOwnerSession,
      )
    : undefined
  const finalTierRaised = Boolean(earlierRound && evidence.tier > earlierRound.tier)
  if (
    creditedRoundReview.lenses.length > 0 &&
    earlierRound &&
    !composed.coverageGaps.missingLenses.length &&
    !composed.coverageGaps.undisposedFindings.length &&
    composed.coverageGaps.missingSecondOpinion === null &&
    !exact.currentPatch.unfinishedReviewNumbers.length &&
    !exact.currentPatch.undisposedFindings.length
  ) {
    return {
      complete: true,
      snapshot: {
        reviewRecordIds: earlierRound.reviews.map((review) => review.reviewRecordId).sort(),
        patchId: evidence.patchId,
        tier: evidence.tier,
        lensRounds: recordedLensRounds(earlierRound.reviews),
        findingCount: earlierRound.reviews.flatMap((review) => review.findings).length,
        admissionPath: 'exact_review',
        readRecordId: null,
      },
    }
  }
  if (
    earlierRound &&
    !finalTierRaised &&
    exactRead &&
    !exact.currentPatch.unfinishedReviewNumbers.length &&
    !exact.currentPatch.undisposedFindings.length
  ) {
    return {
      complete: true,
      snapshot: architectReadSnapshot(evidence, earlierRound, exactRead.recordId),
    }
  }
  return incompleteTriageDecision({
    exact,
    composed,
    earlierRound,
    exactRead,
    finalTierRaised,
    hasCompletedBranchReview,
  })
}
