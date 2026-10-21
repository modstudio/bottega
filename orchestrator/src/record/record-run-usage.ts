// concern: hosted run usage validation
/** Validates usage provenance before a run crosses into the hosted record. */

import { VENDOR_COST_SOURCES, type VendorCostSource } from '../transport/vendor-usage.ts'
import { OutboxRowError } from './outbox-failure.ts'

const VENDOR_COST_SOURCE_SET = new Set<string>(VENDOR_COST_SOURCES)

export function nullableVendorCostSource(value: unknown): VendorCostSource | null {
  if (value == null) return null
  const source = String(value)
  if (!VENDOR_COST_SOURCE_SET.has(source)) {
    throw new OutboxRowError(
      'run.vendorCostSource must be billed, partial, estimated, none, or null',
      'row-validation',
    )
  }
  return source as VendorCostSource
}
