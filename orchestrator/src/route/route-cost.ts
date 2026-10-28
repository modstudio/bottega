// concern: route-cost
/** Gathers and prices the complete chains in one routing evidence window. */

import { db } from '../database/db.ts'
import { jobTakesFidelity } from '../jobs/job-fidelity.ts'
import { type SubscriptionCostContext, withReportedCost } from '../run/run-subscription-cost.ts'
import { subscriptionCostFacts } from '../run/run-subscription-cost-store.ts'
import { promptBucketSql } from './prompt-size-bucket.ts'
import { routingEvidenceWindow } from './route-statistics.ts'

export type AcceptedResultChain = {
  accepted: boolean
  rows: Array<{ usd: number | null; source: string | null }>
}

export type CostPerAcceptedResult = { usd: number; imputed?: number } | { unknown: string }

export type CostEvidenceRoot = {
  record_id: string
  delivery: string | null
  quality: string | null
  fidelity: string | null
}

type ChainCostRow = {
  rootRecordId: string
  agent: string
  started_at: string
  vendor_tokens: number | null
  vendor_cost_usd: number | null
  vendor_estimated_cost_usd: number | null
  vendor_cost_source: string | null
  quota_resets_at: number | null
  latency_ms: number | null
}

type ReportedCost = { usd: number | null; source: string | null; availableAt?: string | null }
export type RouteCostFacts = Map<string, ReportedCost[]>

function pricedFacts(rows: ChainCostRow[], context: SubscriptionCostContext): RouteCostFacts {
  const costsByRoot: RouteCostFacts = new Map()
  for (const row of rows) {
    const cost = withReportedCost(row, context)
    costsByRoot.set(row.rootRecordId, [
      ...(costsByRoot.get(row.rootRecordId) ?? []),
      {
        usd: cost.cost_usd,
        source: cost.cost_source,
        availableAt:
          row.latency_ms === null
            ? null
            : new Date(Date.parse(row.started_at) + row.latency_ms).toISOString(),
      },
    ])
  }
  return costsByRoot
}

/** Price every eligible historical chain once for causal replay adapters. */
export function allRouteCostFacts(context?: SubscriptionCostContext): RouteCostFacts {
  const rows = db()
    .query(
      `SELECT COALESCE(r.parent_run_record_id, r.record_id) AS rootRecordId,
              r.agent, r.started_at, r.vendor_tokens, r.vendor_cost_usd,
              r.vendor_estimated_cost_usd, r.vendor_cost_source, r.quota_resets_at, r.latency_ms
         FROM run r
         JOIN run root ON root.record_id = COALESCE(r.parent_run_record_id, r.record_id)
        WHERE root.status IN ('ok','failed','stale') AND root.probe = 0
          AND root.evidence_excluded IS NULL AND root.executor <> 'harness'`,
    )
    .all() as ChainCostRow[]
  return pricedFacts(rows, context ?? { facts: subscriptionCostFacts(), prices: {} })
}

function costPerDenominator(
  chains: AcceptedResultChain[],
  denominator: number,
): CostPerAcceptedResult {
  const rows = chains.flatMap((chain) => chain.rows)
  if (rows.length === 0) return { unknown: 'cost unavailable' }
  const priced = rows.filter(
    (row): row is { usd: number; source: string | null } => row.usd !== null,
  )
  const unpriced = rows.filter((row) => row.usd === null)
  if (unpriced.length > 0 && priced.length * 2 < rows.length) {
    const counts = new Map<string, number>()
    for (const row of unpriced) {
      const source = row.source ?? 'cost unavailable'
      counts.set(source, (counts.get(source) ?? 0) + 1)
    }
    const dominant = [...counts].sort((left, right) => right[1] - left[1])[0]?.[0]
    return { unknown: dominant ?? 'cost unavailable' }
  }
  const pricedTotal = priced.reduce((sum, row) => sum + row.usd, 0)
  const mean = priced.length === 0 ? 0 : pricedTotal / priced.length
  const result = { usd: (pricedTotal + mean * unpriced.length) / denominator }
  return unpriced.length === 0 ? result : { ...result, imputed: unpriced.length }
}

/** Prices all work spent on the cell against only the chains that earned an accepted result. */
export function costPerAcceptedResult(chains: AcceptedResultChain[]): CostPerAcceptedResult {
  const accepted = chains.filter((chain) => chain.accepted).length
  return accepted === 0 ? { unknown: 'no accepted results' } : costPerDenominator(chains, accepted)
}

/** Mean chain cost with the same partial-pricing imputation as cost per accepted result. */
function costPerRunResult(chains: AcceptedResultChain[]): CostPerAcceptedResult {
  return chains.length === 0
    ? { unknown: 'cost unavailable' }
    : costPerDenominator(chains, chains.length)
}

export function routeCostFacts(input: {
  jobName: string
  promptBytes: number
  stack?: string | null
  lens?: string | null
  context?: SubscriptionCostContext
}): RouteCostFacts {
  const rows = db()
    .query(
      `SELECT COALESCE(r.parent_run_record_id, r.record_id) AS rootRecordId,
              r.agent, r.started_at, r.vendor_tokens, r.vendor_cost_usd,
              r.vendor_estimated_cost_usd, r.vendor_cost_source,
              r.quota_resets_at, r.latency_ms
         FROM run r
         JOIN run root ON root.record_id = COALESCE(r.parent_run_record_id, r.record_id)
        WHERE root.job = ? AND root.status IN ('ok','failed','stale') AND root.probe = 0
          AND root.evidence_excluded IS NULL AND root.executor <> 'harness'
          AND ${promptBucketSql('root', input.promptBytes)}
          ${input.stack ? 'AND root.stack = ?' : ''}
          ${input.lens ? 'AND EXISTS (SELECT 1 FROM review_lens rl WHERE rl.run_record_id = root.record_id AND rl.lens = ?)' : ''}`,
    )
    .all(
      input.jobName,
      ...(input.stack ? [input.stack] : []),
      ...(input.lens ? [input.lens] : []),
    ) as ChainCostRow[]
  const context = input.context ?? { facts: subscriptionCostFacts(), prices: {} }
  return pricedFacts(rows, context)
}

export function routeCostPerAccepted(
  jobName: string,
  roots: CostEvidenceRoot[],
  costsByRoot: RouteCostFacts,
): CostPerAcceptedResult {
  return costPerAcceptedResult(
    roots.map((root) => ({
      accepted:
        root.delivery === 'full' &&
        root.quality === 'right' &&
        (!jobTakesFidelity(jobName) || root.fidelity === 'faithful'),
      rows: costsByRoot.get(root.record_id) ?? [],
    })),
  )
}

export function routeMeanCostPerRun(
  roots: CostEvidenceRoot[],
  costsByRoot: RouteCostFacts,
): CostPerAcceptedResult {
  return costPerRunResult(
    roots.map((root) => ({ accepted: false, rows: costsByRoot.get(root.record_id) ?? [] })),
  )
}

export function attachRouteCosts<
  T extends {
    agent: string
    evidenceModel: string | null
    costPerAccepted?: CostPerAcceptedResult
  },
  E extends CostEvidenceRoot & { agent: string; model: string | null; startedAt: string },
>(
  candidates: T[],
  evidenceRows: E[],
  input: { jobName: string; promptBytes: number; stack?: string | null; lens?: string | null },
  evidenceWindow: number,
  enabled: boolean,
): void {
  if (!enabled) return
  const facts = routeCostFacts(input)
  for (const candidate of candidates) {
    const window = routingEvidenceWindow(
      evidenceRows,
      candidate.agent,
      candidate.evidenceModel!,
      evidenceWindow,
    )
    candidate.costPerAccepted = routeCostPerAccepted(input.jobName, window.rows, facts)
  }
}
