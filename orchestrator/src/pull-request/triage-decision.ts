// concern: pull-request-triage-decision
/** Decides whether recorded review evidence admits one exact change group. */

import type { ApplicableReview } from '../review/review-applicability.ts'
import type { TriageReviewRow } from '../review/review-group.ts'

export type TriageReviewGroup = {
  reviews: readonly TriageReviewRow[]
  applicableReview: ApplicableReview
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
    id: number
    tip: string
    patchId: string
    pathSet: string
    recordedAt: string
    sessionId: string | null
  }[]
}

type TriageSnapshot = {
  reviewIds: number[]
  patchId: string
  tier: 0 | 1 | 2 | 3
  lensRounds: number
  findingCount: number
  admissionPath: 'exact_review' | 'architect_read'
  readId: number | null
}

export type TriageDecision =
  | { complete: true; snapshot: TriageSnapshot }
  | {
      complete: false
      snapshot: TriageSnapshot
      missingReview: boolean
      unfinishedReviewIds: number[]
      undisposedFindings: { id: number; reviewId: number; ordinal: number }[]
      missingLenses: string[]
      missingSecondOpinion: { lens: string; firstRunId: string | null } | null
      architectReadRequired: boolean
      earlierReviewId: number | null
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
    .sort((left, right) => left.id - right.id)
  const models = new Set(opinions.flatMap((opinion) => (opinion.model ? [opinion.model] : [])))
  if (opinions.length >= 2 && models.size >= 2) return { complete: true }
  return { complete: false, lens, firstRunId: opinions[0]?.runId ?? null }
}

function mostRecentCompleteRound(
  branchReviewGroups: readonly TriageReviewGroup[],
): CompleteReviewRound | null {
  for (const { reviews, applicableReview } of branchReviewGroups) {
    if (reviews.some((review) => review.completedAt === null || review.tier === null)) continue
    if (reviews.some((review) => review.findings.some((finding) => finding.disposition === null))) {
      continue
    }
    const tier = Math.max(...reviews.map((review) => review.tier!)) as 0 | 1 | 2 | 3
    const judged = new Set(reviews.flatMap((review) => review.lensIdentities))
    if (applicableReview.lenses.some((lens) => !judged.has(lens))) continue
    if (!decideSecondOpinion(reviews, applicableReview.secondOpinion).complete) continue
    return {
      reviews,
      tier,
      completedAt: reviews
        .map((review) => review.completedAt!)
        .sort((left, right) => right.localeCompare(left))[0]!,
    }
  }
  return null
}

/** One pure decision over the already-selected rows for a patch/path change group. */
export function decideTriage(evidence: TriageEvidence): TriageDecision {
  const reviewIds = [...new Set(evidence.reviews.map((row) => row.reviewId))].sort((a, b) => a - b)
  const lensRounds = recordedLensRounds(evidence.reviews)
  const findings = evidence.reviews.flatMap((review) =>
    review.findings.map((finding) => ({
      ...finding,
      reviewId: review.reviewId,
    })),
  )
  const snapshot = {
    reviewIds,
    patchId: evidence.patchId,
    tier: evidence.tier,
    lensRounds,
    findingCount: findings.length,
    admissionPath: 'exact_review' as const,
    readId: null,
  }
  const missingReview = evidence.applicableReview.lenses.length > 0 && reviewIds.length === 0
  const unfinishedReviewIds = evidence.reviews
    .filter((row) => row.completedAt === null)
    .map((row) => row.reviewId)
    .sort((a, b) => a - b)
  const undisposedFindings = findings
    .filter((finding) => finding.disposition === null)
    .map(({ id, reviewId, ordinal }) => ({ id, reviewId, ordinal }))
    .sort((a, b) => a.id - b.id)
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
    !unfinishedReviewIds.length &&
    !undisposedFindings.length &&
    !missingLenses.length &&
    missingSecondOpinion === null
  ) {
    return { complete: true, snapshot }
  }
  const earlierRound = mostRecentCompleteRound(evidence.branchReviewGroups)
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
  if (earlierRound && !finalTierRaised && exactRead) {
    return {
      complete: true,
      snapshot: {
        reviewIds: earlierRound.reviews.map((review) => review.reviewId).sort((a, b) => a - b),
        patchId: evidence.patchId,
        tier: evidence.tier,
        lensRounds: recordedLensRounds(earlierRound.reviews),
        findingCount: earlierRound.reviews.flatMap((review) => review.findings).length,
        admissionPath: 'architect_read',
        readId: exactRead.id,
      },
    }
  }
  return {
    complete: false,
    snapshot,
    missingReview,
    unfinishedReviewIds,
    undisposedFindings,
    missingLenses,
    missingSecondOpinion,
    architectReadRequired: Boolean(earlierRound && !finalTierRaised && !exactRead),
    earlierReviewId: earlierRound?.reviews[0]?.reviewId ?? null,
    earlierReviewTier: earlierRound?.tier ?? null,
    finalTierRaised,
  }
}
