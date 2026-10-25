// concern: openrouter-auth-failure
/** Maps a run's auth failure onto an exhausted OpenRouter key budget, beside the vendor decision it reads. */
import type { FailureKind } from '../failure/failure.ts'
import {
  type OpenRouterKeyBudgetDecision,
  openRouterKeyBudgetRefusal,
} from './openrouter-key-budget.ts'

/** Replace only an auth failure proved to be an exhausted OpenRouter key. */
export function applyOpenRouterBudgetToAuthFailure(
  failureKind: FailureKind | null,
  error: string | null,
  decision: OpenRouterKeyBudgetDecision,
): {
  failureKind: FailureKind | null
  error: string | null
  billingHoldDetail?: string
} {
  if (failureKind !== 'auth' || decision.kind !== 'exhausted') return { failureKind, error }
  const refusal = openRouterKeyBudgetRefusal(decision)
  return {
    failureKind: 'billing',
    error: error ? `${error}\n${refusal}` : refusal,
    billingHoldDetail: refusal,
  }
}
