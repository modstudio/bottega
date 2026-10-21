// concern: hosted run usage validation
/** Validates usage provenance before a run crosses into the hosted record. */

import { RUN_RESOURCE_SOURCES, type RunResourceSource } from '../process-resource-sampler.ts'
import { VENDOR_COST_SOURCES, type VendorCostSource } from '../transport/vendor-usage.ts'
import { OutboxRowError } from './outbox-failure.ts'

const VENDOR_COST_SOURCE_SET = new Set<string>(VENDOR_COST_SOURCES)
const RUN_RESOURCE_SOURCE_SET = new Set<string>(RUN_RESOURCE_SOURCES)

function nullableVendorCostSource(value: unknown): VendorCostSource | null {
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

function nullableRunResourceSource(value: unknown): RunResourceSource | null {
  if (value == null) return null
  const source = String(value)
  if (!RUN_RESOURCE_SOURCE_SET.has(source)) {
    throw new OutboxRowError(
      'run.resourceSource must be sampled, none, unavailable, or null',
      'row-validation',
    )
  }
  return source as RunResourceSource
}

const nullableBigint = (value: unknown) => (value == null ? null : BigInt(String(value)))
const nullableNumber = (value: unknown) => (value == null ? null : Number(value))

function nullableInteger(value: unknown): number | null {
  if (value == null) return null
  const integer = Number(value)
  if (!Number.isInteger(integer)) {
    throw new OutboxRowError('run resource samples must be an integer or null', 'row-validation')
  }
  return integer
}

export function runUsageRecordValues(row: Record<string, unknown>) {
  return {
    vendorTokens: nullableBigint(row.vendorTokens),
    vendorCostUsd: nullableNumber(row.vendorCostUsd),
    vendorInputTokens: nullableBigint(row.vendorInputTokens),
    vendorOutputTokens: nullableBigint(row.vendorOutputTokens),
    vendorEstimatedCostUsd: nullableNumber(row.vendorEstimatedCostUsd),
    vendorCostSource: nullableVendorCostSource(row.vendorCostSource),
    resourceCpuMs: nullableBigint(row.resourceCpuMs),
    resourcePeakRssBytes: nullableBigint(row.resourcePeakRssBytes),
    resourceSamples: nullableInteger(row.resourceSamples),
    resourceSource: nullableRunResourceSource(row.resourceSource),
  }
}
