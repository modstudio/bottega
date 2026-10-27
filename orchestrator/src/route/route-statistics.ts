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

export type AcceptedResultChain = {
  accepted: boolean
  rows: Array<{ usd: number | null; source: string | null }>
}

export type CostPerAcceptedResult = { usd: number } | { unknown: string }

type RoutingWindowRow = {
  record_id: string
  agent: string
  model: string | null
  startedAt: string
}

/** Keeps only the current model's newest roots in one routing evidence cell. */
export function routingEvidenceWindow<T extends RoutingWindowRow>(
  rows: T[],
  agent: string,
  currentModel: string,
  limit: number,
): { rows: T[]; evidenceModel: string | null } {
  const modelRows = rows
    .filter((row) => row.agent === agent && (row.model === currentModel || row.model === null))
    .sort(
      (a, b) => b.startedAt.localeCompare(a.startedAt) || b.record_id.localeCompare(a.record_id),
    )
    .slice(0, limit)
  return { rows: modelRows, evidenceModel: currentModel }
}

/** Prices all work spent on the cell against only the chains that earned an accepted result. */
export function costPerAcceptedResult(chains: AcceptedResultChain[]): CostPerAcceptedResult {
  let totalUsd = 0
  for (const chain of chains) {
    for (const row of chain.rows) {
      if (row.usd === null) return { unknown: row.source ?? 'cost unavailable' }
      totalUsd += row.usd
    }
  }
  const accepted = chains.filter((chain) => chain.accepted).length
  return accepted === 0 ? { unknown: 'no accepted results' } : { usd: totalUsd / accepted }
}
