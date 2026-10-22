// concern: vendor usage provenance
/** Shared usage provenance values carried from transports into run persistence. */
const VENDOR_COST_SOURCES = ['billed', 'partial', 'estimated', 'none'] as const
export type VendorCostSource = (typeof VENDOR_COST_SOURCES)[number]
export const SUBSCRIPTION_STORED_SOURCE = 'subscription'
export const PERSISTED_VENDOR_COST_SOURCES = [
  ...VENDOR_COST_SOURCES,
  SUBSCRIPTION_STORED_SOURCE,
] as const
export type PersistedVendorCostSource = (typeof PERSISTED_VENDOR_COST_SOURCES)[number]

export type VendorUsage = {
  inputTokens: number | null
  outputTokens: number | null
  estimatedCostUsd: number | null
  costSource: VendorCostSource | null
}

export const EMPTY_VENDOR_USAGE: VendorUsage = {
  inputTokens: null,
  outputTokens: null,
  estimatedCostUsd: null,
  costSource: null,
}
