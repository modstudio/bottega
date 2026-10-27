// concern: route-cost
/** Gathers and prices the complete chains in one routing evidence window. */

import { db } from '../database/db.ts'
import { jobTakesFidelity } from '../jobs/job-fidelity.ts'
import { type SubscriptionCostContext, withReportedCost } from '../run/run-subscription-cost.ts'
import { subscriptionCostFacts } from '../run/run-subscription-cost-store.ts'
import { promptBucketSql } from './prompt-size-bucket.ts'

export type AcceptedResultChain = {
  accepted: boolean
  rows: Array<{ usd: number | null; source: string | null }>
}

export type CostPerAcceptedResult = { usd: number } | { unknown: string }

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
}

type ReportedCost = { usd: number | null; source: string | null }
export type RouteCostFacts = Map<string, ReportedCost[]>

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
              r.vendor_estimated_cost_usd, r.vendor_cost_source
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
  const costsByRoot: RouteCostFacts = new Map()
  for (const row of rows) {
    const cost = withReportedCost(row, context)
    costsByRoot.set(row.rootRecordId, [
      ...(costsByRoot.get(row.rootRecordId) ?? []),
      { usd: cost.cost_usd, source: cost.cost_source },
    ])
  }
  return costsByRoot
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
