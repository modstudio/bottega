// concern: run usage columns
/** Maps transport usage into the four columns persisted on a run. */
import type { VendorUsage } from '../transport/vendor-usage.ts'
import { SUBSCRIPTION_STORED_SOURCE } from './run-subscription-cost.ts'

export type RunUsageColumns = {
  vendorInputTokens: number | null
  vendorOutputTokens: number | null
  vendorEstimatedCostUsd: number | null
  vendorCostSource: string | null
}

export function runUsageColumns(usage: VendorUsage, billing?: string | null): RunUsageColumns {
  if (billing === 'subscription') {
    return {
      vendorInputTokens: usage.inputTokens,
      vendorOutputTokens: usage.outputTokens,
      vendorEstimatedCostUsd: null,
      vendorCostSource: SUBSCRIPTION_STORED_SOURCE,
    }
  }
  return {
    vendorInputTokens: usage.inputTokens,
    vendorOutputTokens: usage.outputTokens,
    vendorEstimatedCostUsd: usage.estimatedCostUsd,
    vendorCostSource: usage.costSource,
  }
}

export function runUsageColumnValues(columns: RunUsageColumns) {
  return [
    columns.vendorInputTokens,
    columns.vendorOutputTokens,
    columns.vendorEstimatedCostUsd,
    columns.vendorCostSource,
  ] as const
}
