export const OUTBOX_REJECTION_QUARANTINE_ATTEMPTS = 3

export type OutboxDeliveryOutcome =
  | { kind: 'applied' }
  | { kind: 'duplicate' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'request-failed'; reason: string }

export type OutboxLifecycleDecision =
  | { action: 'sent' }
  | { action: 'retry'; attempts: number; lastError: string }
  | { action: 'quarantine'; attempts: number; lastError: string; reason: string }
  | { action: 'unchanged' }

/** Decide the durable state transition without knowing either concern's store. */
export function decideOutboxLifecycle(
  attempts: number,
  outcome: OutboxDeliveryOutcome,
  threshold = OUTBOX_REJECTION_QUARANTINE_ATTEMPTS,
): OutboxLifecycleDecision {
  if (outcome.kind === 'applied' || outcome.kind === 'duplicate') return { action: 'sent' }
  if (outcome.kind === 'request-failed') return { action: 'unchanged' }
  const nextAttempts = attempts + 1
  if (nextAttempts >= threshold)
    return {
      action: 'quarantine',
      attempts: nextAttempts,
      lastError: outcome.reason,
      reason: outcome.reason,
    }
  return { action: 'retry', attempts: nextAttempts, lastError: outcome.reason }
}
