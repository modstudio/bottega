// concern: route cost backtest adapter
/** Rebuilds causal routing snapshots from the local evidence store. */

import { AGENTS } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { jobTakesFidelity } from '../jobs/job-fidelity.ts'
import { JOBS } from '../jobs/jobs.ts'
import { reviewTierSizeClass } from '../review/review-tier-classifier.ts'
import type { SubscriptionCostContext } from '../run/run-subscription-cost.ts'
import { type PromptSizeBucket, promptSizeBucket } from './prompt-size-bucket.ts'
import {
  allRouteCostFacts,
  type CostEvidenceRoot,
  type RouteCostFacts,
  routeCostPerAccepted,
  routeMeanCostPerRun,
} from './route-cost.ts'
import {
  type CostBacktestCandidate,
  type CostBacktestDecision,
  type CostBacktestVariant,
  causalEvidenceBefore,
  type FairnessRun,
  routeCostBacktest,
} from './route-cost-backtest.ts'
import {
  DEFAULT_ROUTE_COST_POLICY,
  findingsPolicyLens,
  resolveRouteCostPolicy,
} from './route-cost-policy.ts'
import { currentPolicySelection, MIN_SAMPLE, thompsonRank } from './route-selection.ts'
import {
  type RoutingBacktestEvent,
  routingBacktestCellsFor,
  routingBacktestEvents,
  routingOperationalEvents,
} from './routing-backtest.ts'

type LensRow = { runId: string; lens: string }

function variantsFor(group: string): CostBacktestVariant[] {
  const make = (
    rate: number,
    floor: number | null,
    defaultRate: number,
    defaultFloor: number | null,
  ) => ({
    name: `rate ${rate} / floor ${floor === null ? 'none' : floor}`,
    rate,
    floor,
    shippedDefault: rate === defaultRate && floor === defaultFloor,
  })
  if (group === 'writing') return [2, 3, 5].map((rate) => make(rate, null, 3, null))
  if (group === 'high-stakes') return [0.85, 0.9, 0.95].map((floor) => make(3, floor, 3, 0.9))
  if (group === 'standard') return [0.75, 0.8, 0.85].map((floor) => make(1.5, floor, 1.5, 0.8))
  if (group === 'light') return [0.75, 0.8, 0.85].map((floor) => make(1, floor, 1, 0.8))
  return [1, 1.25, 1.5].flatMap((rate) =>
    [0.75, 0.8, 0.85].map((floor) => make(rate, floor, 1.25, 0.8)),
  )
}

function factsAvailableBefore(
  roots: CostEvidenceRoot[],
  facts: RouteCostFacts,
  startedAt: string,
): RouteCostFacts {
  return new Map(
    roots.map((root) => [
      root.record_id,
      (facts.get(root.record_id) ?? []).filter(
        (row) =>
          row.availableAt !== null && row.availableAt !== undefined && row.availableAt < startedAt,
      ),
    ]),
  )
}

function cellCandidates(
  decision: RoutingBacktestEvent,
  history: RoutingBacktestEvent[],
  latencyHistory: RoutingBacktestEvent[],
  scope: { lens: string | null; stack: string | null },
  facts: RouteCostFacts,
  lensRuns: Map<string, Set<string>>,
  operations: ReturnType<typeof routingOperationalEvents>,
  excluded: ReadonlySet<string>,
): { candidates: CostBacktestCandidate[]; baselineAgent: string | null; eligible: number } {
  const scopedIds = scope.lens ? lensRuns.get(scope.lens) : null
  const scopedEvidence = scopedIds ? history.filter((row) => scopedIds.has(row.record_id)) : history
  const scopedLatency = scopedIds
    ? latencyHistory.filter((row) => scopedIds.has(row.record_id))
    : latencyHistory
  const raw = routingBacktestCellsFor(
    decision,
    scopedEvidence,
    scopedLatency,
    operations,
    true,
    scope.stack,
  ).filter((row) => !excluded.has(row.agent))
  if (raw.length === 0) return { candidates: [], baselineAgent: null, eligible: 0 }
  const proven = raw.filter((row) => row.evidence >= MIN_SAMPLE && row.score !== null)
  const baseline = currentPolicySelection(raw, JOBS[decision.job]?.prefer ?? [], false)
  const means = new Map(
    (proven.length ? thompsonRank(proven, false).posterior : []).map((row) => [
      row.candidate.agent,
      row.mean,
    ]),
  )
  const candidates = raw.map((candidate) => {
    const roots = candidate.events
    const causalFacts = factsAvailableBefore(roots, facts, decision.startedAt)
    const accepted = roots.filter(
      (root) =>
        root.delivery === 'full' &&
        root.quality === 'right' &&
        (!jobTakesFidelity(decision.job) || root.fidelity === 'faithful'),
    ).length
    return {
      agent: candidate.agent,
      qualityValue: means.get(candidate.agent) ?? 0.5,
      shrunk: candidate.shrunk,
      costPerAccepted: routeCostPerAccepted(decision.job, roots, causalFacts),
      meanCostPerRun: routeMeanCostPerRun(roots, causalFacts),
      acceptedShare: roots.length ? accepted / roots.length : null,
      evidence: candidate.evidence,
      proven: candidate.evidence >= MIN_SAMPLE && candidate.score !== null,
      free: candidate.free,
      latencyMs: candidate.latencyMs,
    }
  })
  return { candidates, baselineAgent: baseline.chosen.agent, eligible: raw.length }
}

function enoughForScoped(cell: ReturnType<typeof cellCandidates>): boolean {
  const proven = cell.candidates.filter((candidate) => candidate.proven).length
  return proven >= 2 || (cell.eligible === 1 && proven === 1)
}

export function gatherRouteCostBacktestSnapshots(
  days: number,
  context?: SubscriptionCostContext,
  now = new Date(),
  excluded: ReadonlySet<string> = new Set(),
) {
  const all = routingBacktestEvents()
  const operations = routingOperationalEvents()
  const since = now.getTime() - days * 86_400_000
  const lensByRun = new Map(
    (db().query('SELECT run_record_id AS runId, lens FROM review_lens').all() as LensRow[]).map(
      (row) => [row.runId, row.lens],
    ),
  )
  const lensRuns = new Map<string, Set<string>>()
  for (const [runId, lens] of lensByRun)
    lensRuns.set(lens, new Set([...(lensRuns.get(lens) ?? []), runId]))
  const facts = allRouteCostFacts(context)
  const evidenceByCell = new Map<string, RoutingBacktestEvent[]>()
  for (const row of all) {
    const key = `${row.job}\0${promptSizeBucket(row.promptBytes)}`
    evidenceByCell.set(key, [...(evidenceByCell.get(key) ?? []), row])
  }
  const decisions: CostBacktestDecision[] = []
  const fairnessRuns: FairnessRun[] = []
  const provenAgents = new Map<string, Set<string>>()
  for (const decision of all.filter((row) => Date.parse(row.startedAt) >= since)) {
    const causal = causalEvidenceBefore(
      evidenceByCell.get(`${decision.job}\0${promptSizeBucket(decision.promptBytes)}`) ?? [],
      decision.startedAt,
    )
    const causalLatency = all.filter(
      (row) => row.latencyAt !== null && row.latencyAt < decision.startedAt,
    )
    const requestedLens = findingsPolicyLens(
      Boolean(JOBS[decision.job]?.findings),
      lensByRun.get(decision.record_id),
    )
    let scope = {
      lens: requestedLens,
      stack: requestedLens ? null : decision.stack,
    }
    const cellIn = (within: typeof scope) =>
      cellCandidates(decision, causal, causalLatency, within, facts, lensRuns, operations, excluded)
    let cell =
      scope.lens || scope.stack
        ? cellIn(scope)
        : { candidates: [], baselineAgent: null, eligible: 0 }
    if (!enoughForScoped(cell)) {
      scope = { lens: null, stack: null }
      cell = cellIn(scope)
    }
    if (cell.candidates.length === 0 || cell.baselineAgent === null) continue
    const resolved = resolveRouteCostPolicy(
      DEFAULT_ROUTE_COST_POLICY,
      decision.job,
      requestedLens,
      Boolean(JOBS[decision.job]?.needs.writesRepo),
    )
    const promptBucket: PromptSizeBucket = promptSizeBucket(decision.promptBytes)
    decisions.push({
      job: decision.job,
      promptBucket,
      lens: requestedLens,
      group: resolved.group,
      baselineAgent: cell.baselineAgent,
      candidates: cell.candidates,
      variants: variantsFor(resolved.group),
    })
    const key = `${decision.job}\0${promptBucket}\0${scope.lens ?? ''}`
    const proven = cell.candidates.filter((candidate) => candidate.proven)
    provenAgents.set(
      key,
      new Set([...(provenAgents.get(key) ?? []), ...proven.map((candidate) => candidate.agent)]),
    )
    fairnessRuns.push({
      job: decision.job,
      promptBucket,
      lens: scope.lens,
      agent: decision.agent,
      promptBytes: decision.promptBytes,
      sizeClass:
        decision.linesAdded === null || decision.linesRemoved === null
          ? null
          : reviewTierSizeClass(decision.linesAdded + decision.linesRemoved),
    })
  }
  return { decisions, fairnessRuns, provenAgents }
}

export function gatherRouteCostBacktest(
  days: number,
  context?: SubscriptionCostContext,
  now = new Date(),
  excluded: ReadonlySet<string> = new Set(),
) {
  const unknown = [...excluded].filter((name) => !AGENTS[name])
  if (unknown.length) throw new Error(`--without names no agent: ${unknown.join(', ')}`)
  const snapshot = gatherRouteCostBacktestSnapshots(days, context, now, excluded)
  return routeCostBacktest(snapshot.decisions, snapshot.fairnessRuns, snapshot.provenAgents, days)
}
