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

const getUserScopeEntry: SubscriptionPriceLookup = (key) => getEntry(key, 'user')

function isMissingUserEntry(error: unknown): boolean {
  return error instanceof ConfigClientError && error.status === 404
}

export async function loadSubscriptionPrices(
  harnesses: readonly string[],
  get: SubscriptionPriceLookup = getUserScopeEntry,
): Promise<Record<string, number | null>> {
  const prices: Record<string, number | null> = {}
  for (const harness of harnesses) {
    const key = subscriptionMonthlyUsdKey(harness)
    try {
      const row = await get(key)
      prices[harness] = parseSubscriptionMonthlyUsd(row.value)
    } catch (error) {
      if (isMissingUserEntry(error)) {
        prices[harness] = null
        continue
      }
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`refusing to read user-scope ${key}: ${detail}`)
    }
  }
  return prices
}

export async function loadSubscriptionCostContext(
  get: SubscriptionPriceLookup = getUserScopeEntry,
): Promise<SubscriptionCostContext> {
  const facts = subscriptionCostFacts()
  return { facts, prices: await loadSubscriptionPrices(subscriptionHarnesses(facts), get) }
}
