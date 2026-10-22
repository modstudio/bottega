// concern: run-subscription-cost
/** Derives a subscription run's dollar cost from its share of the monthly price. */

export const SUBSCRIPTION_STORED_SOURCE = 'subscription'
export const SUBSCRIPTION_AMORTIZED_SOURCE = 'subscription, amortized'
export const SUBSCRIPTION_UNPRICED_SOURCE = 'subscription, unpriced'

export type ReportedRunCost = {
  usd: number | null
  source: string | null
}

type SubscriptionAgent = {
  billing: string
  harness: string
}

export type SubscriptionCostFacts = {
  agents: Readonly<Record<string, SubscriptionAgent>>
  monthTokens: Readonly<Record<string, number>>
}

const PRICE_KEY = /^subscription\.([^.]+)\.monthly_usd$/

export function subscriptionMonthlyUsdKey(harness: string): string {
  return `subscription.${harness}.monthly_usd`
}

export const SUBSCRIPTION_PRICE_HARNESSES = ['codex', 'grok'] as const

export function harnessFromSubscriptionPriceKey(key: string): string | null {
  const match = PRICE_KEY.exec(key)
  return match?.[1] ?? null
}

export function parseSubscriptionMonthlyUsd(value: string): number | null {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}

function utcCalendarMonth(startedAt: string): string {
  const instant = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(startedAt) ? startedAt : `${startedAt}Z`
  const date = new Date(instant)
  if (Number.isNaN(date.getTime())) return startedAt.slice(0, 7)
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${date.getUTCFullYear()}-${month}`
}

function subscriptionMonthTokenKey(harness: string, startedAt: string): string {
  return `${harness}:${utcCalendarMonth(startedAt)}`
}

export function amortizedSubscriptionShare(input: {
  monthlyPriceUsd: number | null
  runTokens: number | null
  monthTokens: number | null
}): ReportedRunCost {
  if (input.monthlyPriceUsd == null) {
    return { usd: null, source: SUBSCRIPTION_UNPRICED_SOURCE }
  }
  const runTokens = input.runTokens ?? 0
  const monthTokens = input.monthTokens ?? 0
  if (monthTokens <= 0) return { usd: 0, source: SUBSCRIPTION_AMORTIZED_SOURCE }
  return {
    usd: (input.monthlyPriceUsd * runTokens) / monthTokens,
    source: SUBSCRIPTION_AMORTIZED_SOURCE,
  }
}

export function reportedRunCost(input: {
  billing: string | null | undefined
  billedUsd: number | null
  estimatedUsd: number | null
  storedSource: string | null
  monthlyPriceUsd: number | null
  runTokens: number | null
  monthTokens: number | null
}): ReportedRunCost {
  if (input.billing === 'subscription') {
    return amortizedSubscriptionShare({
      monthlyPriceUsd: input.monthlyPriceUsd,
      runTokens: input.runTokens,
      monthTokens: input.monthTokens,
    })
  }
  return { usd: input.billedUsd, source: input.storedSource }
}

export function reportedCostForRun(
  run: {
    agent: string
    startedAt: string
    vendorTokens: number | null
    vendorCostUsd: number | null
    vendorEstimatedCostUsd: number | null
    vendorCostSource: string | null
  },
  facts: SubscriptionCostFacts,
  prices: Readonly<Record<string, number | null>>,
): ReportedRunCost {
  const agent = facts.agents[run.agent]
  const harness = agent?.harness
  return reportedRunCost({
    billing: agent?.billing,
    billedUsd: run.vendorCostUsd,
    estimatedUsd: run.vendorEstimatedCostUsd,
    storedSource: run.vendorCostSource,
    monthlyPriceUsd: harness == null ? null : (prices[harness] ?? null),
    runTokens: run.vendorTokens,
    monthTokens:
      harness == null
        ? null
        : (facts.monthTokens[subscriptionMonthTokenKey(harness, run.startedAt)] ?? null),
  })
}
