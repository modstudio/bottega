// concern: pull-request-triage-decision
/** Decides whether recorded review evidence admits one exact change group. */

import type { TriageReviewRow } from '../review/review-group.ts'

export type TriageEvidence = {
  patchId: string
  pathSet: string
  tip: string
  tier: 0 | 1 | 2 | 3
  reviews: readonly TriageReviewRow[]
  branchReviews: readonly TriageReviewRow[]
  reads: readonly {
    id: number
    tip: string
    patchId: string
    pathSet: string
    recordedAt: string
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
      roundsOwed: number
      architectReadRequired: boolean
      earlierReviewId: number | null
      earlierReviewTier: 0 | 1 | 2 | 3 | null
      finalTierRaised: boolean
    }

/** One pure decision over the already-selected rows for a patch/path change group. */
export function decideTriage(evidence: TriageEvidence): TriageDecision {
  const reviewIds = [...new Set(evidence.reviews.map((row) => row.reviewId))].sort((a, b) => a - b)
  const lensRounds = new Set(evidence.reviews.flatMap((row) => row.lensIds)).size
  const findings = evidence.reviews.flatMap((review) =>
    review.findings.map((finding) => ({ ...finding, reviewId: review.reviewId })),
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
  const missingReview = evidence.tier > 0 && reviewIds.length === 0
  const unfinishedReviewIds = evidence.reviews
    .filter((row) => row.completedAt === null)
    .map((row) => row.reviewId)
    .sort((a, b) => a - b)
  const undisposedFindings = findings
    .filter((finding) => finding.disposition === null)
    .map(({ id, reviewId, ordinal }) => ({ id, reviewId, ordinal }))
    .sort((a, b) => a.id - b.id)
  const roundsOwed = Math.max(0, evidence.tier - lensRounds)
  if (!missingReview && !unfinishedReviewIds.length && !undisposedFindings.length && !roundsOwed) {
    return { complete: true, snapshot }
  }
  const earlierReview = evidence.branchReviews.find((review) => {
    const lensRounds = new Set(review.lensIds).size
    return (
      review.completedAt !== null &&
      review.tier !== null &&
      lensRounds >= review.tier &&
      review.findings.every((finding) => finding.disposition !== null)
    )
  })
  const exactRead = earlierReview
    ? evidence.reads.find(
        (read) =>
          read.tip === evidence.tip &&
          read.patchId === evidence.patchId &&
          read.pathSet === evidence.pathSet &&
          read.recordedAt > earlierReview.completedAt!,
      )
    : undefined
  const finalTierRaised = Boolean(
    earlierReview?.tier !== null && earlierReview && evidence.tier > earlierReview.tier!,
  )
  if (earlierReview && !finalTierRaised && exactRead) {
    return {
      complete: true,
      snapshot: {
        reviewIds: [earlierReview.reviewId],
        patchId: evidence.patchId,
        tier: evidence.tier,
        lensRounds: new Set(earlierReview.lensIds).size,
        findingCount: earlierReview.findings.length,
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
    roundsOwed,
    architectReadRequired: Boolean(earlierReview && !finalTierRaised && !exactRead),
    earlierReviewId: earlierReview?.reviewId ?? null,
    earlierReviewTier: earlierReview?.tier ?? null,
    finalTierRaised,
  }
}
