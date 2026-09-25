// concern: pull-request-triage-decision
/** Decides whether recorded review evidence admits one exact change group. */

import type { TriageReviewRow } from '../review/review-group.ts'

export type TriageEvidence = {
  patchId: string
  tier: 0 | 1 | 2 | 3
  reviews: readonly TriageReviewRow[]
}

type TriageSnapshot = {
  reviewIds: number[]
  patchId: string
  tier: 0 | 1 | 2 | 3
  lensRounds: number
  findingCount: number
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
  return {
    complete: false,
    snapshot,
    missingReview,
    unfinishedReviewIds,
    undisposedFindings,
    roundsOwed,
  }
}
