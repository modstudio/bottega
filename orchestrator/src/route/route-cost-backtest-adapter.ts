// concern: route cost backtest adapter
/** Rebuilds causal routing snapshots from the local evidence store. */

import { AGENTS } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { jobTakesFidelity } from '../jobs/job-fidelity.ts'
import { JOBS } from '../jobs/jobs.ts'
import { reviewTierSizeClass } from '../review/review-tier-classifier.ts'
import type { SubscriptionCostContext } from '../run/run-subscription-cost.ts'
import { median } from '../state/statistics.ts'
import {
  promptSizeBucket,
  promptSizeBucketLabel,
  samePromptSizeBucket,
} from './prompt-size-bucket.ts'
import { EVIDENCE_WINDOW } from './route.ts'
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
import { DEFAULT_ROUTE_COST_POLICY, resolveRouteCostPolicy } from './route-cost-policy.ts'
import { currentPolicySelection, MIN_SAMPLE, thompsonRank } from './route-selection.ts'
import { routingEvidenceWindow } from './route-statistics.ts'
import {
  type RoutingBacktestEvent,
  routingBacktestEvents,
  staticEligible,
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
  scope: { lens: string | null; stack: string | null },
  facts: RouteCostFacts,
  lensRuns: Map<string, Set<string>>,
): { candidates: CostBacktestCandidate[]; baselineAgent: string | null; eligible: number } {
  const evidence = history.filter(
    (row) =>
      row.job === decision.job &&
      samePromptSizeBucket(row.promptBytes, decision.promptBytes) &&
      (!scope.stack || row.stack === scope.stack),
  )
  const scopedIds = scope.lens ? lensRuns.get(scope.lens) : null
  const scopedEvidence = scopedIds
    ? evidence.filter((row) => scopedIds.has(row.record_id))
    : evidence
  const raw = Object.keys(AGENTS)
    .filter((agent) => staticEligible(agent, decision.job, decision.promptBytes))
    .map((agent) => {
      const window = routingEvidenceWindow(
        scopedEvidence,
        agent,
        AGENTS[agent]!.model,
        EVIDENCE_WINDOW,
      )
      const rows = window.rows
      const score = rows.length
        ? rows.reduce((sum, row) => sum + row.weight, 0) / rows.length
        : null
      return {
        agent,
        rows,
        scored: rows.filter((row) => row.scored).length,
        failures: rows.filter((row) => !row.scored).length,
        none: rows.filter((row) => row.none).length,
        evidence: rows.length,
        score,
        shrunk: null as number | null,
        free: ['free', 'none'].includes(AGENTS[agent]!.billing),
        latencyMs: median(rows.flatMap((row) => (row.latencyMs === null ? [] : [row.latencyMs]))),
      }
    })
  const provenScores = raw
    .filter((row) => row.evidence >= MIN_SAMPLE && row.score !== null)
    .map((row) => row.score!)
  const prior = provenScores.length
    ? provenScores.reduce((sum, score) => sum + score, 0) / provenScores.length
    : 0.5
  for (const row of raw)
    if (row.score !== null)
      row.shrunk = (row.score * row.evidence + MIN_SAMPLE * prior) / (row.evidence + MIN_SAMPLE)
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
    const roots = candidate.rows
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

export function gatherRouteCostBacktest(
  days: number,
  context?: SubscriptionCostContext,
  now = new Date(),
) {
  const all = routingBacktestEvents()
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
    const key = `${row.job}\0${promptSizeBucketLabel(promptSizeBucket(row.promptBytes))}`
    evidenceByCell.set(key, [...(evidenceByCell.get(key) ?? []), row])
  }
  const decisions: CostBacktestDecision[] = []
  const fairnessRuns: FairnessRun[] = []
  const provenAgents = new Map<string, Set<string>>()
  for (const decision of all.filter((row) => Date.parse(row.startedAt) >= since)) {
    const causal = causalEvidenceBefore(
      evidenceByCell.get(
        `${decision.job}\0${promptSizeBucketLabel(promptSizeBucket(decision.promptBytes))}`,
      ) ?? [],
      decision.startedAt,
    )
    const lens = lensByRun.get(decision.record_id) ?? null
    let scope = { lens, stack: null as string | null }
    let cell = lens
      ? cellCandidates(decision, causal, scope, facts, lensRuns)
      : { candidates: [], baselineAgent: null, eligible: 0 }
    if (!enoughForScoped(cell) && decision.stack) {
      scope = { lens: null, stack: decision.stack }
      cell = cellCandidates(decision, causal, scope, facts, lensRuns)
    }
    if (!enoughForScoped(cell)) {
      scope = { lens: null, stack: null }
      cell = cellCandidates(decision, causal, scope, facts, lensRuns)
    }
    if (cell.candidates.length === 0 || cell.baselineAgent === null) continue
    const resolved = resolveRouteCostPolicy(
      DEFAULT_ROUTE_COST_POLICY,
      decision.job,
      scope.lens,
      Boolean(JOBS[decision.job]?.needs.writesRepo),
    )
    const promptBucket = promptSizeBucketLabel(promptSizeBucket(decision.promptBytes))
    decisions.push({
      job: decision.job,
      promptBucket,
      lens: scope.lens,
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
  return routeCostBacktest(decisions, fairnessRuns, provenAgents, days)
}
