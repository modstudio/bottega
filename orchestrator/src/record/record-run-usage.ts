// concern: record-run-usage
/** Validates usage provenance before a run crosses into the hosted record. */

import { RUN_RESOURCE_SOURCES, type RunResourceSource } from '../process-resource-sampler.ts'
import {
  PERSISTED_VENDOR_COST_SOURCES,
  type PersistedVendorCostSource,
} from '../transport/vendor-usage.ts'
import { OutboxRowError } from './outbox-failure.ts'
import { nullableBigint, nullableNumber } from './record-value-conversions.ts'

const VENDOR_COST_SOURCE_SET = new Set<string>(PERSISTED_VENDOR_COST_SOURCES)
const RUN_RESOURCE_SOURCE_SET = new Set<string>(RUN_RESOURCE_SOURCES)

function nullableVendorCostSource(value: unknown): PersistedVendorCostSource | null {
  if (value == null) return null
  const source = String(value)
  if (!VENDOR_COST_SOURCE_SET.has(source)) {
    throw new OutboxRowError(
      'run.vendorCostSource must be billed, partial, estimated, none, subscription, or null',
      'row-validation',
    )
  }
  return source as PersistedVendorCostSource
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

function nullableInteger(value: unknown): number | null {
  if (value == null) return null
  const integer = Number(value)
  if (!Number.isInteger(integer)) {
    throw new OutboxRowError('run resource samples must be an integer or null', 'row-validation')
  }
  return integer
}

function nullableModelCalls(value: unknown): number | null {
  if (value == null) return null
  const integer = Number(value)
  if (!Number.isInteger(integer)) {
    throw new OutboxRowError('run.model_calls must be an integer or null', 'row-validation')
  }
  return integer
}

function nullableRoundedBigint(value: unknown): bigint | null {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new OutboxRowError(
      'run resource measurement must be a finite number or null',
      'row-validation',
    )
  }
  return BigInt(Math.round(value))
}

export function runUsageRecordValues(row: Record<string, unknown>) {
  return {
    vendorTokens: nullableBigint(row.vendorTokens),
    modelCalls: nullableModelCalls(row.modelCalls),
    peakCallTokens: nullableBigint(row.peakCallTokens),
    quotaUsedPercentStart: nullableNumber(row.quotaUsedPercentStart),
    quotaUsedPercentEnd: nullableNumber(row.quotaUsedPercentEnd),
    quotaWindowMinutes: nullableModelCalls(row.quotaWindowMinutes),
    quotaResetsAt: nullableBigint(row.quotaResetsAt),
    vendorCostUsd: nullableNumber(row.vendorCostUsd),
    vendorInputTokens: nullableBigint(row.vendorInputTokens),
    vendorOutputTokens: nullableBigint(row.vendorOutputTokens),
    vendorEstimatedCostUsd: nullableNumber(row.vendorEstimatedCostUsd),
    vendorCostSource: nullableVendorCostSource(row.vendorCostSource),
    resourceCpuMs: nullableRoundedBigint(row.resourceCpuMs),
    resourcePeakRssBytes: nullableRoundedBigint(row.resourcePeakRssBytes),
    resourceSamples: nullableInteger(row.resourceSamples),
    resourceSource: nullableRunResourceSource(row.resourceSource),
  }
}
