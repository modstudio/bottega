// concern: review-finding-restore-policy
/** Decides whether an outbox finding can be restored without knowing SQLite. */
import { z } from 'zod'

export const restoreFindingPayloadSchema = z
  .object({
    localId: z.number().int().positive(),
    reviewId: z.string().min(1),
    reviewLensId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    severity: z.string().min(1),
    location: z.string(),
    evidence: z.string(),
    proposedCorrection: z.string(),
  })
  .transform(({ reviewId, reviewLensId, ...finding }) => ({
    ...finding,
    reviewRecordId: reviewId,
    reviewLensRecordId: reviewLensId,
  }))

export type RestoreFindingPayload = z.infer<typeof restoreFindingPayloadSchema>

export type RestoreFindingFacts = {
  existingFindingIds: ReadonlySet<number>
  findingIdByReviewOrdinal: ReadonlyMap<string, number>
  reviewIdByRecordId: ReadonlyMap<string, number>
  lensByRecordId: ReadonlyMap<string, { id: number; reviewId: number }>
}

export type RestoreFindingDecision =
  | { action: 'insert'; reviewId: number; reviewLensId: number }
  | { action: 'skip'; reason: string }
  | { action: 'refuse'; reason: string }

export type OrderedRestoreFindingPayload = {
  outboxId: number
  payload: RestoreFindingPayload
}

export type OrderedRestoreFindingDecision = OrderedRestoreFindingPayload &
  (
    | { action: 'insert'; reviewId: number; reviewLensId: number }
    | { action: 'skip'; reason: string }
    | { action: 'duplicate'; reason: string }
    | { action: 'refuse'; reason: string }
  )

export function reviewOrdinalKey(reviewId: number, ordinal: number): string {
  return `${reviewId}:${ordinal}`
}

export function decideFindingRestore(
  payload: RestoreFindingPayload,
  facts: RestoreFindingFacts,
): RestoreFindingDecision {
  if (facts.existingFindingIds.has(payload.localId)) {
    return {
      action: 'skip',
      reason: `finding ${payload.localId} is already present`,
    }
  }
  const reviewId = facts.reviewIdByRecordId.get(payload.reviewRecordId)
  if (reviewId === undefined) {
    return {
      action: 'refuse',
      reason: `finding ${payload.localId} references missing review ${payload.reviewRecordId}`,
    }
  }
  const lens = facts.lensByRecordId.get(payload.reviewLensRecordId)
  if (!lens) {
    return {
      action: 'refuse',
      reason: `finding ${payload.localId} references missing review lens ${payload.reviewLensRecordId}`,
    }
  }
  if (lens.reviewId !== reviewId) {
    return {
      action: 'refuse',
      reason:
        `finding ${payload.localId} references review ${payload.reviewRecordId} but lens ` +
        `${payload.reviewLensRecordId} belongs to review ${lens.reviewId}`,
    }
  }
  const ordinalOwner = facts.findingIdByReviewOrdinal.get(
    reviewOrdinalKey(reviewId, payload.ordinal),
  )
  if (ordinalOwner !== undefined) {
    return {
      action: 'refuse',
      reason:
        `finding ${payload.localId} cannot use review ${reviewId} ordinal ${payload.ordinal}; ` +
        `finding ${ordinalOwner} already uses it`,
    }
  }
  return { action: 'insert', reviewId, reviewLensId: lens.id }
}

function samePayload(left: RestoreFindingPayload, right: RestoreFindingPayload): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** The first ordered payload for a finding wins; exact repeats are duplicates and conflicts refuse. */
export function decideFindingRestores(
  ordered: readonly OrderedRestoreFindingPayload[],
  facts: RestoreFindingFacts,
): OrderedRestoreFindingDecision[] {
  const winners = new Map<number, RestoreFindingPayload>()
  const existingFindingIds = new Set(facts.existingFindingIds)
  const findingIdByReviewOrdinal = new Map(facts.findingIdByReviewOrdinal)
  const decisions: OrderedRestoreFindingDecision[] = []

  for (const item of ordered) {
    const winner = winners.get(item.payload.localId)
    if (winner) {
      decisions.push(
        samePayload(winner, item.payload)
          ? {
              ...item,
              action: 'duplicate',
              reason: `finding ${item.payload.localId} repeats an identical payload`,
            }
          : {
              ...item,
              action: 'refuse',
              reason: `finding ${item.payload.localId} has conflicting outbox payloads`,
            },
      )
      continue
    }
    winners.set(item.payload.localId, item.payload)
    const decision = decideFindingRestore(item.payload, {
      ...facts,
      existingFindingIds,
      findingIdByReviewOrdinal,
    })
    decisions.push({ ...item, ...decision })
    if (decision.action === 'insert') {
      existingFindingIds.add(item.payload.localId)
      findingIdByReviewOrdinal.set(
        reviewOrdinalKey(decision.reviewId, item.payload.ordinal),
        item.payload.localId,
      )
    }
  }
  return decisions
}
