// concern: run-subscription-prices
/** Reads user-scope subscription monthly prices from hosted configuration. */
import { listEntries } from '../config/config-service.ts'
import {
  harnessFromSubscriptionPriceKey,
  parseSubscriptionMonthlyUsd,
} from './run-subscription-cost.ts'

export async function loadSubscriptionPrices(
  list = listEntries,
): Promise<Record<string, number | null>> {
  try {
    const prices: Record<string, number | null> = {}
    for (const row of await list()) {
      if (row.scope !== 'user') continue
      const harness = harnessFromSubscriptionPriceKey(row.key)
      if (!harness) continue
      prices[harness] = parseSubscriptionMonthlyUsd(row.value)
    }
    return prices
  } catch {
    return {}
  }
}
