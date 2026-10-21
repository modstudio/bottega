// concern: run usage columns
/** Maps transport usage into the four columns persisted on a run. */
import type { VendorUsage } from '../transport/vendor-usage.ts'

export type RunUsageColumns = {
  vendorInputTokens: number | null
  vendorOutputTokens: number | null
  vendorEstimatedCostUsd: number | null
  vendorCostSource: string | null
}

export function runUsageColumns(usage: VendorUsage): RunUsageColumns {
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
