// concern: route-statistics
/** Computes descriptive statistics for one routing evidence window. */
import { median } from '../state/statistics.ts'

type EvidenceRow = { delivery: string | null; pts: number | null }

export function aggregateEvidence(rows: EvidenceRow[]) {
  return {
    scored: rows.filter((row) => row.delivery !== null).length,
    failures: rows.filter((row) => row.delivery === null).length,
    none: rows.filter((row) => row.delivery === 'none').length,
    pts: rows.reduce((sum, row) => sum + (row.pts ?? 0), 0),
  }
}

export type RunUsageMedians = {
  modelCalls: number | null
  peakCallTokens: number | null
  tokensPerRun: number | null
}

export function runUsageMedians(
  rows: Array<{
    vendorTokens: number | null
    modelCalls: number | null
    peakCallTokens: number | null
  }>,
): RunUsageMedians {
  const values = (key: 'vendorTokens' | 'modelCalls' | 'peakCallTokens') =>
    rows.flatMap((row) => (row[key] === null ? [] : [row[key]]))
  return {
    modelCalls: median(values('modelCalls')),
    peakCallTokens: median(values('peakCallTokens')),
    tokensPerRun: median(values('vendorTokens')),
  }
}
