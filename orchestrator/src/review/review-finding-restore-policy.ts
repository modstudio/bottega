// concern: review-finding-restore-policy
/** Decides whether an outbox finding can be restored without knowing SQLite. */
import { z } from 'zod'

export const restoreFindingPayloadSchema = z
  .object({
    id: z.uuid(),
    reviewId: z.string().min(1),
    reviewLensId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    severity: z.string().min(1),
    location: z.string(),
    evidence: z.string(),
    proposedCorrection: z.string(),
  })
  .transform(({ id, reviewId, reviewLensId, ...finding }) => ({
    ...finding,
    recordId: id,
    reviewRecordId: reviewId,
    reviewLensRecordId: reviewLensId,
  }))

export type RestoreFindingPayload = z.infer<typeof restoreFindingPayloadSchema>

export type RestoreFindingFacts = {
  existingFindingIds: ReadonlySet<string>
  findingIdByReviewOrdinal: ReadonlyMap<string, string>
  reviewIdByRecordId: ReadonlyMap<string, string>
  lensByRecordId: ReadonlyMap<string, { recordId: string; reviewRecordId: string }>
}

export type RestoreFindingDecision =
  | { action: 'insert'; reviewRecordId: string; reviewLensRecordId: string }
  | { action: 'skip'; reason: string }
  | { action: 'refuse'; reason: string }

export type OrderedRestoreFindingPayload = {
  outboxId: number
  payload: RestoreFindingPayload
}

export type OrderedRestoreFindingDecision = OrderedRestoreFindingPayload &
  (
    | { action: 'insert'; reviewRecordId: string; reviewLensRecordId: string }
    | { action: 'skip'; reason: string }
    | { action: 'duplicate'; reason: string }
    | { action: 'refuse'; reason: string }
  )

export function reviewOrdinalKey(reviewId: string, ordinal: number): string {
  return `${reviewId}:${ordinal}`
}

export function decideFindingRestore(
  payload: RestoreFindingPayload,
  facts: RestoreFindingFacts,
): RestoreFindingDecision {
  if (facts.existingFindingIds.has(payload.recordId)) {
    return {
      action: 'skip',
      reason: `finding ${payload.recordId} is already present`,
    }
  }
  const reviewId = facts.reviewIdByRecordId.get(payload.reviewRecordId)
  if (reviewId === undefined) {
    return {
      action: 'refuse',
      reason: `finding ${payload.recordId} references missing review ${payload.reviewRecordId}`,
    }
  }
  const lens = facts.lensByRecordId.get(payload.reviewLensRecordId)
  if (!lens) {
    return {
      action: 'refuse',
      reason: `finding ${payload.recordId} references missing review lens ${payload.reviewLensRecordId}`,
    }
  }
  if (lens.reviewRecordId !== reviewId) {
    return {
      action: 'refuse',
      reason:
        `finding ${payload.recordId} references review ${payload.reviewRecordId} but lens ` +
        `${payload.reviewLensRecordId} belongs to review ${lens.reviewRecordId}`,
    }
  }
  const ordinalOwner = facts.findingIdByReviewOrdinal.get(
    reviewOrdinalKey(reviewId, payload.ordinal),
  )
  if (ordinalOwner !== undefined) {
    return {
      action: 'refuse',
      reason:
        `finding ${payload.recordId} cannot use review ${reviewId} ordinal ${payload.ordinal}; ` +
        `finding ${ordinalOwner} already uses it`,
    }
  }
  return { action: 'insert', reviewRecordId: reviewId, reviewLensRecordId: lens.recordId }
}

function samePayload(left: RestoreFindingPayload, right: RestoreFindingPayload): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** The first ordered payload for a finding wins; exact repeats are duplicates and conflicts refuse. */
export function decideFindingRestores(
  ordered: readonly OrderedRestoreFindingPayload[],
  facts: RestoreFindingFacts,
): OrderedRestoreFindingDecision[] {
  const winners = new Map<string, RestoreFindingPayload>()
  const existingFindingIds = new Set(facts.existingFindingIds)
  const findingIdByReviewOrdinal = new Map(facts.findingIdByReviewOrdinal)
  const decisions: OrderedRestoreFindingDecision[] = []

  for (const item of ordered) {
    const winner = winners.get(item.payload.recordId)
    if (winner) {
      decisions.push(
        samePayload(winner, item.payload)
          ? {
              ...item,
              action: 'duplicate',
              reason: `finding ${item.payload.recordId} repeats an identical payload`,
            }
          : {
              ...item,
              action: 'refuse',
              reason: `finding ${item.payload.recordId} has conflicting outbox payloads`,
            },
      )
      continue
    }
    winners.set(item.payload.recordId, item.payload)
    const decision = decideFindingRestore(item.payload, {
      ...facts,
      existingFindingIds,
      findingIdByReviewOrdinal,
    })
    decisions.push({ ...item, ...decision })
    if (decision.action === 'insert') {
      existingFindingIds.add(item.payload.recordId)
      findingIdByReviewOrdinal.set(
        reviewOrdinalKey(decision.reviewRecordId, item.payload.ordinal),
        item.payload.recordId,
      )
    }
  }
  return decisions
}
