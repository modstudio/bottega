// concern: run-subscription-cost
/** Derives a subscription run's dollar cost from its share of the monthly price. */
import type { Agent } from '../agent/agents.ts'

export const SUBSCRIPTION_AMORTIZED_SOURCE = 'subscription, amortized'
export const SUBSCRIPTION_UNPRICED_SOURCE = 'subscription, unpriced'
export const SUBSCRIPTION_NO_TOKENS_SOURCE = 'subscription, no tokens'

export type AgentBilling = Agent['billing']

export type ReportedRunCost = {
  usd: number | null
  source: string | null
}

type ReportedCostRunRow = {
  agent: string
  started_at: string
  vendor_tokens: number | null
  vendor_cost_usd: number | null
  vendor_estimated_cost_usd: number | null
  vendor_cost_source: string | null
}

type CostRowFields = {
  agent?: unknown
  started_at?: unknown
  vendor_tokens?: unknown
  vendor_cost_usd?: unknown
  vendor_estimated_cost_usd?: unknown
  vendor_cost_source?: unknown
}

type SubscriptionAgent = {
  billing: AgentBilling
  harness: string
}

export type SubscriptionCostFacts = {
  agents: Readonly<Record<string, SubscriptionAgent>>
  monthTokens: Readonly<Record<string, number>>
}

export type SubscriptionCostContext = {
  facts: SubscriptionCostFacts
  prices: Readonly<Record<string, number | null>>
}

export function subscriptionMonthlyUsdKey(harness: string): string {
  return `subscription.${harness}.monthly_usd`
}

export function parseSubscriptionMonthlyUsd(value: string): number | null {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}

/** Every stored started_at is UTC ISO, so the calendar month is the YYYY-MM prefix. */
function subscriptionCalendarMonth(startedAt: string): string {
  return startedAt.slice(0, 7)
}

export function subscriptionMonthTokenKey(harness: string, startedAt: string): string {
  return `${harness}:${subscriptionCalendarMonth(startedAt)}`
}

export function subscriptionHarnesses(facts: SubscriptionCostFacts): string[] {
  const harnesses = new Set<string>()
  for (const agent of Object.values(facts.agents)) {
    if (agent.billing === 'subscription') harnesses.add(agent.harness)
  }
  return [...harnesses]
}

export function amortizedSubscriptionShare(input: {
  monthlyPriceUsd: number | null
  runTokens: number | null
  monthTokens: number | null
}): ReportedRunCost {
  if (input.monthlyPriceUsd == null) {
    return { usd: null, source: SUBSCRIPTION_UNPRICED_SOURCE }
  }
  if (input.runTokens == null) {
    return { usd: null, source: SUBSCRIPTION_NO_TOKENS_SOURCE }
  }
  const monthTokens = input.monthTokens ?? 0
  if (monthTokens <= 0) return { usd: 0, source: SUBSCRIPTION_AMORTIZED_SOURCE }
  return {
    usd: (input.monthlyPriceUsd * input.runTokens) / monthTokens,
    source: SUBSCRIPTION_AMORTIZED_SOURCE,
  }
}

export function reportedRunCost(input: {
  billing: AgentBilling | null | undefined
  billedUsd: number | null
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

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function reportedCostRunRow(row: CostRowFields): ReportedCostRunRow {
  return {
    agent: typeof row.agent === 'string' ? row.agent : String(row.agent ?? ''),
    started_at: typeof row.started_at === 'string' ? row.started_at : String(row.started_at ?? ''),
    vendor_tokens: nullableNumber(row.vendor_tokens),
    vendor_cost_usd: nullableNumber(row.vendor_cost_usd),
    vendor_estimated_cost_usd: nullableNumber(row.vendor_estimated_cost_usd),
    vendor_cost_source: row.vendor_cost_source == null ? null : String(row.vendor_cost_source),
  }
}

function reportedCostForRun(
  run: ReportedCostRunRow,
  context: SubscriptionCostContext,
): ReportedRunCost {
  const agent = context.facts.agents[run.agent]
  const harness = agent?.harness
  return reportedRunCost({
    billing: agent?.billing,
    billedUsd: run.vendor_cost_usd,
    storedSource: run.vendor_cost_source,
    monthlyPriceUsd: harness == null ? null : (context.prices[harness] ?? null),
    runTokens: run.vendor_tokens,
    monthTokens:
      harness == null
        ? null
        : (context.facts.monthTokens[subscriptionMonthTokenKey(harness, run.started_at)] ?? null),
  })
}

export function withReportedCost<Row extends CostRowFields>(
  row: Row,
  context: SubscriptionCostContext,
): Row & { cost_usd: number | null; cost_source: string | null } {
  const cost = reportedCostForRun(reportedCostRunRow(row), context)
  return { ...row, cost_usd: cost.usd, cost_source: cost.source }
}
