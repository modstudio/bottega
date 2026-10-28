// concern: run usage columns
/** Maps transport usage and quota readings into the columns persisted on a run. */
import type { QuotaReadings } from '../transport/quota-readings.ts'
import { SUBSCRIPTION_STORED_SOURCE, type VendorUsage } from '../transport/vendor-usage.ts'

export type RunUsageColumns = {
  vendorInputTokens: number | null
  vendorOutputTokens: number | null
  vendorEstimatedCostUsd: number | null
  vendorCostSource: string | null
}

export function runUsageColumns(
  usage: VendorUsage,
  billing?: 'subscription' | 'free' | 'metered' | 'none' | 'unknown' | null,
): RunUsageColumns {
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

export function quotaReadingsColumnValues(readings: QuotaReadings) {
  return [
    readings.quotaUsedPercentStart,
    readings.quotaUsedPercentEnd,
    readings.quotaWindowMinutes,
    readings.quotaResetsAt,
  ] as const
}
