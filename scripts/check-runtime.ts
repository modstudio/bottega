// The suite budget detects runtime regressions. The generous hung-suite bound
// separately stops a wedged child from hanging the gate indefinitely.
export const SUITE_RUNTIME_BUDGET_MS = 120_000
export const HUNG_SUITE_TIMEOUT_MS = 900_000

export type RuntimeBudgetVerdict = 'within' | 'over-informational' | 'over-fatal'

export function decideRuntimeBudget({
  elapsedMs,
  budgetMs,
  ci,
}: {
  elapsedMs: number
  budgetMs: number
  ci: boolean
}): RuntimeBudgetVerdict {
  if (elapsedMs <= budgetMs) return 'within'
  return ci ? 'over-fatal' : 'over-informational'
}
