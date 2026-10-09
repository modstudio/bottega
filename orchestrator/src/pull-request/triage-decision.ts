// concern: pull-request-triage-decision
/** Decides whether recorded review evidence admits one exact change group. */

import type { TriageReviewRow } from '../review/review-group.ts'

export type TriageReviewGroup = {
  reviews: readonly TriageReviewRow[]
  applicableLenses: readonly string[]
}

export type TriageEvidence = {
  patchId: string
  pathSet: string
  tip: string
  tier: 0 | 1 | 2 | 3
  applicableLenses: readonly string[]
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

function mostRecentCompleteRound(
  branchReviewGroups: readonly TriageReviewGroup[],
): CompleteReviewRound | null {
  for (const { reviews, applicableLenses } of branchReviewGroups) {
    if (reviews.some((review) => review.completedAt === null || review.tier === null)) continue
    if (reviews.some((review) => review.findings.some((finding) => finding.disposition === null))) {
      continue
    }
    const tier = Math.max(...reviews.map((review) => review.tier!)) as 0 | 1 | 2 | 3
    const judged = new Set(reviews.flatMap((review) => review.lensIdentities))
    if (applicableLenses.some((lens) => !judged.has(lens))) continue
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
  const lensRounds = new Set(evidence.reviews.flatMap((row) => row.lensIdentities)).size
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
  const missingReview = evidence.applicableLenses.length > 0 && reviewIds.length === 0
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
  const missingLenses = evidence.applicableLenses.filter((lens) => !judgedLenses.has(lens))
  if (
    !missingReview &&
    !unfinishedReviewIds.length &&
    !undisposedFindings.length &&
    !missingLenses.length
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
        lensRounds: new Set(earlierRound.reviews.flatMap((review) => review.lensIdentities)).size,
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
    architectReadRequired: Boolean(earlierRound && !finalTierRaised && !exactRead),
    earlierReviewId: earlierRound?.reviews[0]?.reviewId ?? null,
    earlierReviewTier: earlierRound?.tier ?? null,
    finalTierRaised,
  }
}
