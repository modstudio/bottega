export const OUTBOX_REJECTION_QUARANTINE_ATTEMPTS = 3

type OutboxDeliveryOutcome =
  | { kind: 'applied' }
  | { kind: 'duplicate' }
  | { kind: 'rejected'; reason: string }

type OutboxLifecycleDecision =
  | { action: 'sent' }
  | { action: 'retry'; attempts: number; lastError: string }
  | { action: 'quarantine'; attempts: number; lastError: string; reason: string }

export function decideOutboxLifecycle(
  attempts: number,
  outcome: OutboxDeliveryOutcome,
  threshold = OUTBOX_REJECTION_QUARANTINE_ATTEMPTS,
): OutboxLifecycleDecision {
  if (outcome.kind === 'applied' || outcome.kind === 'duplicate') return { action: 'sent' }
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
