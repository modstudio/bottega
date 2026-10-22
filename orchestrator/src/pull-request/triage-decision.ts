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
      missingLenses: string[]
      missingSecondOpinion: { lens: string; firstRunId: string | null } | null
      architectReadRequired: boolean
      earlierReviewNumber: number | null
      earlierReviewTier: 0 | 1 | 2 | 3 | null
      finalTierRaised: boolean
    }

type CompleteReviewRound = {
  reviews: readonly TriageReviewRow[]
  tier: 0 | 1 | 2 | 3
  completedAt: string
}

type ComposedReviewEvidence = {
  round: CompleteReviewRound | null
  missingLenses: string[]
  undisposedFindings: { reviewNumber: number; ordinal: number }[]
  missingSecondOpinion: { lens: string; firstRunId: string | null } | null
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

function composedReviewEvidence(
  branchReviewGroups: readonly TriageReviewGroup[],
  applicableReview: ApplicableReview,
): ComposedReviewEvidence {
  const completed = branchReviewGroups
    .flatMap(({ reviews }) => reviews)
    .filter((review) => review.completedAt !== null)
    .sort((left, right) => right.completedAt!.localeCompare(left.completedAt!))
  const selected = new Map<string, TriageReviewRow>()
  const missingLenses: string[] = []
  const undisposedFindings: { reviewNumber: number; ordinal: number }[] = []
  for (const lens of applicableReview.lenses) {
    const latest = completed.find((review) => review.lensIdentities.includes(lens))
    if (!latest || latest.tier === null) {
      missingLenses.push(lens)
      continue
    }
    const untriaged = latest.findings
      .filter(({ disposition }) => disposition === null)
      .map(({ ordinal }) => ({ reviewNumber: latest.reviewNumber, ordinal }))
    if (untriaged.length) {
      undisposedFindings.push(...untriaged)
      continue
    }
    selected.set(latest.reviewRecordId, latest)
  }
  const selectedReviews = [...selected.values()]
  if (missingLenses.length || undisposedFindings.length || !selectedReviews.length) {
    return { round: null, missingLenses, undisposedFindings, missingSecondOpinion: null }
  }
  const secondOpinionReviews = applicableReview.secondOpinion
    ? completed.filter((review) => review.lensIdentities.includes(applicableReview.secondOpinion!))
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
  if (!opinionSelection.complete) {
    return {
      round: null,
      missingLenses: [],
      undisposedFindings: [],
      missingSecondOpinion: {
        lens: opinionSelection.lens,
        firstRunId: opinionSelection.firstRunId,
      },
    }
  }
  const opinionUndisposed = opinionSelection.credited.flatMap((review) =>
    review.findings
      .filter(({ disposition }) => disposition === null)
      .map(({ ordinal }) => ({ reviewNumber: review.reviewNumber, ordinal })),
  )
  if (opinionUndisposed.length) {
    return {
      round: null,
      missingLenses: [],
      undisposedFindings: opinionUndisposed,
      missingSecondOpinion: null,
    }
  }
  const reviews = [
    ...new Map(
      [...selectedReviews, ...opinionSelection.credited].map((review) => [
        review.reviewRecordId,
        review,
      ]),
    ).values(),
  ]
  return {
    round: {
      reviews,
      tier: Math.max(...reviews.map((review) => review.tier!)) as 0 | 1 | 2 | 3,
      completedAt: reviews
        .map((review) => review.completedAt!)
        .sort((left, right) => right.localeCompare(left))[0]!,
    },
    missingLenses: [],
    undisposedFindings: [],
    missingSecondOpinion: null,
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
    unfinishedReviewNumbers: evidence.reviews
      .filter((row) => row.completedAt === null)
      .map((row) => row.reviewNumber)
      .sort((left, right) => left - right),
    undisposedFindings: findings
      .filter((finding) => finding.disposition === null)
      .map(({ reviewNumber, ordinal }) => ({ reviewNumber, ordinal }))
      .sort((a, b) => a.reviewNumber - b.reviewNumber || a.ordinal - b.ordinal),
    missingLenses: evidence.applicableReview.lenses.filter((lens) => !judgedLenses.has(lens)),
    missingSecondOpinion: secondOpinion.complete
      ? null
      : { lens: secondOpinion.lens, firstRunId: secondOpinion.firstRunId },
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
  return {
    complete: false,
    snapshot: exact.snapshot,
    missingReview:
      (earlierRound && !finalTierRaised) || hasCompletedBranchReview ? false : exact.missingReview,
    unfinishedReviewNumbers: exact.unfinishedReviewNumbers,
    undisposedFindings: [
      ...new Map(
        [...exact.undisposedFindings, ...composed.undisposedFindings].map((finding) => [
          `${finding.reviewNumber}/${finding.ordinal}`,
          finding,
        ]),
      ).values(),
    ].sort((a, b) => a.reviewNumber - b.reviewNumber || a.ordinal - b.ordinal),
    missingLenses:
      earlierRound && !finalTierRaised
        ? []
        : hasCompletedBranchReview && composed.missingLenses.length
          ? composed.missingLenses
          : exact.missingLenses,
    missingSecondOpinion:
      earlierRound && !finalTierRaised
        ? null
        : ((hasCompletedBranchReview ? composed.missingSecondOpinion : null) ??
          exact.missingSecondOpinion),
    architectReadRequired: Boolean(earlierRound && !finalTierRaised && !exactRead),
    earlierReviewNumber: earlierRound?.reviews[0]?.reviewNumber ?? null,
    earlierReviewTier: earlierRound?.tier ?? null,
    finalTierRaised,
  }
}

/** One pure decision over the already-selected rows for a patch/path change group. */
export function decideTriage(evidence: TriageEvidence): TriageDecision {
  const exact = exactReviewEvidence(evidence)
  if (
    !exact.missingReview &&
    !exact.unfinishedReviewNumbers.length &&
    !exact.undisposedFindings.length &&
    !exact.missingLenses.length &&
    exact.missingSecondOpinion === null
  ) {
    return { complete: true, snapshot: exact.snapshot }
  }
  const composed = composedReviewEvidence(evidence.branchReviewGroups, evidence.applicableReview)
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
    earlierRound &&
    !finalTierRaised &&
    exactRead &&
    !exact.unfinishedReviewNumbers.length &&
    !exact.undisposedFindings.length
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
