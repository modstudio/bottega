// concern: pull-request-triage-decision
/** Decides whether recorded review evidence admits one exact change group. */

import type { ApplicableReview } from '../review/review-applicability.ts'
import type { TriageReviewRow } from '../review/review-group.ts'

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

function recordedLensRounds(reviews: readonly TriageReviewRow[]): number {
  return reviews.reduce((count, review) => count + review.lenses.length, 0)
}

export type SecondOpinionDecision =
  | { complete: true }
  | { complete: false; lens: string; firstRunId: string | null }

/** Require two completed, graded runs of the lens with distinct recorded effective models. */
export function decideSecondOpinion(
  reviews: readonly TriageReviewRow[],
  lens: string | undefined,
): SecondOpinionDecision {
  if (!lens) return { complete: true }
  const opinions = reviews
    .filter((review) => review.completedAt !== null)
    .flatMap((review) => review.lenses)
    .filter((opinion) => opinion.graded && opinion.lens === lens)
    .sort((left, right) => left.recordId.localeCompare(right.recordId))
  const models = new Set(opinions.flatMap((opinion) => (opinion.model ? [opinion.model] : [])))
  if (opinions.length >= 2 && models.size >= 2) return { complete: true }
  return { complete: false, lens, firstRunId: opinions[0]?.runId ?? null }
}

function creditedSecondOpinionReviews(
  reviews: readonly TriageReviewRow[],
  lens: string | undefined,
): readonly TriageReviewRow[] | null {
  if (!lens) return []
  const eligible = reviews.filter(
    (review) =>
      review.completedAt !== null &&
      review.tier !== null &&
      review.findings.every((finding) => finding.disposition !== null),
  )
  if (!decideSecondOpinion(eligible, lens).complete) return null
  const opinions = eligible
    .flatMap((review) =>
      review.lenses.map((opinion) => ({
        opinion,
        review,
      })),
    )
    .filter(({ opinion }) => opinion.graded && opinion.lens === lens && opinion.model)
    .sort((left, right) => left.opinion.recordId.localeCompare(right.opinion.recordId))
  const first = opinions[0]!
  const second = opinions.find(({ opinion }) => opinion.model !== first.opinion.model)!
  return [
    ...new Map(
      [first.review, second.review].map((review) => [review.reviewRecordId, review]),
    ).values(),
  ]
}

function composedCompleteRound(
  branchReviewGroups: readonly TriageReviewGroup[],
  applicableReview: ApplicableReview,
): CompleteReviewRound | null {
  const completed = branchReviewGroups
    .flatMap(({ reviews }) => reviews)
    .filter((review) => review.completedAt !== null)
    .sort((left, right) => right.completedAt!.localeCompare(left.completedAt!))
  const selected = new Map<string, TriageReviewRow>()
  for (const lens of applicableReview.lenses) {
    const latest = completed.find((review) => review.lensIdentities.includes(lens))
    if (
      !latest ||
      latest.tier === null ||
      latest.findings.some((finding) => finding.disposition === null)
    ) {
      return null
    }
    selected.set(latest.reviewRecordId, latest)
  }
  const selectedReviews = [...selected.values()]
  if (!selectedReviews.length) return null
  const secondOpinionReviews = applicableReview.secondOpinion
    ? completed.filter((review) => review.lensIdentities.includes(applicableReview.secondOpinion!))
    : []
  const opinionReviews = creditedSecondOpinionReviews(
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
  if (opinionReviews === null) return null
  const reviews = [
    ...new Map(
      [...selectedReviews, ...opinionReviews].map((review) => [review.reviewRecordId, review]),
    ).values(),
  ]
  return {
    reviews,
    tier: Math.max(...reviews.map((review) => review.tier!)) as 0 | 1 | 2 | 3,
    completedAt: reviews
      .map((review) => review.completedAt!)
      .sort((left, right) => right.localeCompare(left))[0]!,
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

/** One pure decision over the already-selected rows for a patch/path change group. */
export function decideTriage(evidence: TriageEvidence): TriageDecision {
  const reviewRecordIds = [...new Set(evidence.reviews.map((row) => row.reviewRecordId))].sort()
  const lensRounds = recordedLensRounds(evidence.reviews)
  const findings = evidence.reviews.flatMap((review) =>
    review.findings.map((finding) => ({
      ...finding,
      reviewNumber: review.reviewNumber,
    })),
  )
  const snapshot = {
    reviewRecordIds,
    patchId: evidence.patchId,
    tier: evidence.tier,
    lensRounds,
    findingCount: findings.length,
    admissionPath: 'exact_review' as const,
    readRecordId: null,
  }
  const missingReview = evidence.applicableReview.lenses.length > 0 && reviewRecordIds.length === 0
  const unfinishedReviewNumbers = evidence.reviews
    .filter((row) => row.completedAt === null)
    .map((row) => row.reviewNumber)
    .sort((left, right) => left - right)
  const undisposedFindings = findings
    .filter((finding) => finding.disposition === null)
    .map(({ reviewNumber, ordinal }) => ({ reviewNumber, ordinal }))
    .sort((a, b) => a.reviewNumber - b.reviewNumber || a.ordinal - b.ordinal)
  const judgedLenses = new Set(
    evidence.reviews
      .filter((review) => review.completedAt !== null)
      .flatMap((review) => review.lensIdentities),
  )
  const missingLenses = evidence.applicableReview.lenses.filter((lens) => !judgedLenses.has(lens))
  const secondOpinion = decideSecondOpinion(
    evidence.reviews,
    evidence.applicableReview.secondOpinion,
  )
  const missingSecondOpinion = secondOpinion.complete
    ? null
    : { lens: secondOpinion.lens, firstRunId: secondOpinion.firstRunId }
  if (
    !missingReview &&
    !unfinishedReviewNumbers.length &&
    !undisposedFindings.length &&
    !missingLenses.length &&
    missingSecondOpinion === null
  ) {
    return { complete: true, snapshot }
  }
  const earlierRound = composedCompleteRound(evidence.branchReviewGroups, evidence.applicableReview)
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
    !unfinishedReviewNumbers.length &&
    !undisposedFindings.length
  ) {
    return {
      complete: true,
      snapshot: architectReadSnapshot(evidence, earlierRound, exactRead.recordId),
    }
  }
  return {
    complete: false,
    snapshot,
    missingReview: earlierRound && !finalTierRaised ? false : missingReview,
    unfinishedReviewNumbers,
    undisposedFindings,
    missingLenses: earlierRound && !finalTierRaised ? [] : missingLenses,
    missingSecondOpinion: earlierRound && !finalTierRaised ? null : missingSecondOpinion,
    architectReadRequired: Boolean(earlierRound && !finalTierRaised && !exactRead),
    earlierReviewNumber: earlierRound?.reviews[0]?.reviewNumber ?? null,
    earlierReviewTier: earlierRound?.tier ?? null,
    finalTierRaised,
  }
}
