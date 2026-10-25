// concern: openrouter-key-budget
/** Decides and checks whether a configured OpenRouter key can spend. */

import { resolveEndpointApiKeyEnv } from './endpoint-api-key.ts'

type OpenRouterKeyRow = {
  baseUrl?: string | null
  apiKeySecret?: string | null
  billing?: string | null
}

export type OpenRouterKeyBudgetDecision =
  | { kind: 'spendable' }
  | {
      kind: 'exhausted'
      limitUsd: number
      usedUsd: number
      resetInterval: string
      resetsAt: string | null
    }
  | { kind: 'unknown' }
  | { kind: 'not-applicable' }

export type OpenRouterRecordedBudget =
  | { kind: 'spendable' }
  | { kind: 'unknown'; detail: string }
  | {
      kind: 'exhausted'
      limitUsd: number
      usedUsd: number
      resetInterval: string
      resetsAt: string | null
      refusal: string
    }

const OPENROUTER_KEY_CHECK_TIMEOUT_MS = 4_000

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Interpret only OpenRouter's key endpoint shape; malformed responses are not evidence. */
export function openRouterKeyBudgetDecision(response: unknown): OpenRouterKeyBudgetDecision {
  if (!response || typeof response !== 'object') return { kind: 'unknown' }
  const data = (response as { data?: unknown }).data
  if (!data || typeof data !== 'object') return { kind: 'unknown' }
  const values = data as Record<string, unknown>
  if (values.limit === null) return { kind: 'spendable' }
  if (!finiteNumber(values.limit_remaining)) return { kind: 'unknown' }
  if (values.limit_remaining > 0) return { kind: 'spendable' }
  if (!finiteNumber(values.limit) || typeof values.limit_reset !== 'string')
    return { kind: 'unknown' }
  const used = values[`usage_${values.limit_reset}`]
  if (!finiteNumber(used)) return { kind: 'unknown' }
  const effectiveBudget = values.effective_budget
  if (
    effectiveBudget !== undefined &&
    effectiveBudget !== null &&
    typeof effectiveBudget !== 'object'
  )
    return { kind: 'unknown' }
  const resetsAt = (effectiveBudget as { resets_at?: unknown } | null | undefined)?.resets_at
  if (resetsAt !== undefined && resetsAt !== null && typeof resetsAt !== 'string')
    return { kind: 'unknown' }
  return {
    kind: 'exhausted',
    limitUsd: values.limit,
    usedUsd: used,
    resetInterval: values.limit_reset,
    resetsAt: resetsAt ?? null,
  }
}

export function openRouterKeyBudgetRefusal(
  decision: Extract<OpenRouterKeyBudgetDecision, { kind: 'exhausted' }>,
): string {
  return (
    `the OpenRouter key's ${decision.resetInterval} limit of $${decision.limitUsd} is used ` +
    `($${decision.usedUsd}); it resets at ${decision.resetsAt ?? 'an unknown time'}; ` +
    `raise the key's limit in OpenRouter Keys settings`
  )
}

/** Only a metered, explicitly keyed OpenRouter endpoint spends through this budget. */
function isOpenRouterKeyBudgetAgent(row: OpenRouterKeyRow): boolean {
  if (row.billing !== 'metered' || !row.apiKeySecret?.trim() || !row.baseUrl) return false
  try {
    return new URL(row.baseUrl).hostname === 'openrouter.ai'
  } catch {
    return false
  }
}

type BudgetDependencies = {
  resolve: typeof resolveEndpointApiKeyEnv
  fetch(input: string, init: RequestInit): Promise<Response>
}

const budgetDependencies: BudgetDependencies = {
  resolve: resolveEndpointApiKeyEnv,
  fetch: (input, init) => globalThis.fetch(input, init),
}

/** Resolve the named key at use time and ask OpenRouter without exposing response metadata. */
export async function checkOpenRouterKeyBudget(
  row: OpenRouterKeyRow,
  dependencies: BudgetDependencies = budgetDependencies,
): Promise<OpenRouterKeyBudgetDecision> {
  if (!isOpenRouterKeyBudgetAgent(row)) return { kind: 'not-applicable' }
  try {
    const key = (await dependencies.resolve(row)).OPENAI_API_KEY
    if (!key) return { kind: 'unknown' }
    const response = await dependencies.fetch(`${row.baseUrl!.replace(/\/+$/, '')}/key`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(OPENROUTER_KEY_CHECK_TIMEOUT_MS),
    })
    if (!response.ok) return { kind: 'unknown' }
    return openRouterKeyBudgetDecision(await response.json())
  } catch {
    return { kind: 'unknown' }
  }
}

/** Project an account decision into the probe record and durable routing policy. */
export function openRouterProbeBudget(decision: OpenRouterKeyBudgetDecision): {
  budget?: OpenRouterRecordedBudget
  billingHold: boolean
} {
  if (decision.kind === 'not-applicable') return { billingHold: false }
  if (decision.kind === 'unknown') {
    return {
      budget: { kind: 'unknown', detail: 'OpenRouter key budget not verified' },
      billingHold: false,
    }
  }
  if (decision.kind === 'exhausted') {
    return {
      budget: { ...decision, refusal: openRouterKeyBudgetRefusal(decision) },
      billingHold: true,
    }
  }
  return { budget: decision, billingHold: false }
}

/** Replace only an auth failure proved to be an exhausted OpenRouter key. */
export function applyOpenRouterBudgetToAuthFailure<T extends string | null>(
  failureKind: T,
  error: string | null,
  decision: OpenRouterKeyBudgetDecision,
): { failureKind: T | 'billing'; error: string | null; billingHoldDetail?: string } {
  if (failureKind !== 'auth' || decision.kind !== 'exhausted') return { failureKind, error }
  const refusal = openRouterKeyBudgetRefusal(decision)
  return {
    failureKind: 'billing',
    error: error ? `${error}\n${refusal}` : refusal,
    billingHoldDetail: refusal,
  }
}
