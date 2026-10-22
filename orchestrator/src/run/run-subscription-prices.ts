// concern: run-subscription-prices
/** Reads the current user's subscription monthly prices from hosted configuration. */
import { ConfigClientError } from '../../../shared/config-client.ts'
import { getEntry } from '../config/config-service.ts'
import {
  parseSubscriptionMonthlyUsd,
  type SubscriptionCostContext,
  subscriptionHarnesses,
  subscriptionMonthlyUsdKey,
} from './run-subscription-cost.ts'
import { subscriptionCostFacts } from './run-subscription-cost-store.ts'

export type SubscriptionPriceLookup = (key: string) => Promise<{ value: string }>

export type LoadedSubscriptionPrices = {
  prices: Record<string, number | null>
  unavailable: Record<string, string>
}

const getUserScopeEntry: SubscriptionPriceLookup = (key) => getEntry(key, 'user')

function isMissingUserEntry(error: unknown): boolean {
  return error instanceof ConfigClientError && error.status === 404
}

async function readHarnessPrice(
  harness: string,
  get: SubscriptionPriceLookup,
): Promise<{ harness: string; price: number | null } | { harness: string; unavailable: string }> {
  const key = subscriptionMonthlyUsdKey(harness)
  try {
    const row = await get(key)
    return { harness, price: parseSubscriptionMonthlyUsd(row.value) }
  } catch (error) {
    if (isMissingUserEntry(error)) return { harness, price: null }
    return { harness, unavailable: error instanceof Error ? error.message : String(error) }
  }
}

export function subscriptionPriceReadWarning(
  unavailable: Readonly<Record<string, string>>,
): string | null {
  const first = Object.entries(unavailable)[0]
  if (!first) return null
  const [harness, detail] = first
  return `refusing to read user-scope ${subscriptionMonthlyUsdKey(harness)}: ${detail}`
}

export async function loadSubscriptionPrices(
  harnesses: readonly string[],
  get: SubscriptionPriceLookup = getUserScopeEntry,
): Promise<LoadedSubscriptionPrices> {
  const rows = await Promise.all(harnesses.map((harness) => readHarnessPrice(harness, get)))
  const prices: Record<string, number | null> = {}
  const unavailable: Record<string, string> = {}
  for (const row of rows) {
    if ('unavailable' in row) unavailable[row.harness] = row.unavailable
    else prices[row.harness] = row.price
  }
  return { prices, unavailable }
}

export async function loadSubscriptionCostContext(
  get: SubscriptionPriceLookup = getUserScopeEntry,
  warn: (line: string) => void = (line) => console.error(line),
): Promise<SubscriptionCostContext> {
  const facts = subscriptionCostFacts()
  const loaded = await loadSubscriptionPrices(subscriptionHarnesses(facts), get)
  const warning = subscriptionPriceReadWarning(loaded.unavailable)
  if (warning) warn(warning)
  return { facts, prices: loaded.prices, unavailable: loaded.unavailable }
}
