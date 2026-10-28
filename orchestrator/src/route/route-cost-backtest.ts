// concern: route cost backtest
/** Pure aggregation of causal routing snapshots under cost-policy variants. */

import { median } from '../state/statistics.ts'
import type { PromptSizeBucket } from './prompt-size-bucket.ts'
import type { CostPolicyParameters } from './route-cost-policy.ts'
import { selectByCostPolicy } from './route-cost-policy.ts'
import { BETA_SCALE, NOISE_BAND } from './route-selection.ts'

export type CostBacktestCandidate = {
  agent: string
  qualityValue: number
  shrunk: number | null
  costPerAccepted: { usd: number; imputed?: number } | { unknown: string }
  meanCostPerRun: { usd: number; imputed?: number } | { unknown: string }
  acceptedShare: number | null
  evidence: number
  proven: boolean
  free: boolean
  latencyMs: number | null
}

export type CostBacktestVariant = CostPolicyParameters & { name: string; shippedDefault: boolean }

export type CostBacktestDecision = {
  job: string
  promptBucket: PromptSizeBucket
  lens: string | null
  group: string
  baselineAgent: string
  candidates: CostBacktestCandidate[]
  variants: CostBacktestVariant[]
}

type CostBacktestFigure = {
  variant: CostBacktestVariant
  decisions: { n: number }
  routingShift: {
    n: number
    count: number
    share: number
    moves: Array<{ from: string; to: string; count: number }>
  }
  usdPerWeek: {
    n: number
    baseline: number
    variant: number
    delta: number
    baselineUnpriced: number
    variantUnpriced: number
  }
  acceptedRate: { n: number; baseline: number; variant: number; deltaPoints: number }
  fallbacks: {
    n: number
    allBelowFloor: number
    allCostsUnknown: number
    pickedOrBaselineImputed: number
  }
}

type CostBacktestGroup = { group: string; n: number; figures: CostBacktestFigure[] }

export type FairnessRun = {
  job: string
  promptBucket: PromptSizeBucket
  lens: string | null
  agent: string
  promptBytes: number
  sizeClass: number | null
}

export type FairnessCell = {
  job: string
  promptBucket: PromptSizeBucket
  lens: string | null
  agents: Array<{
    agent: string
    runs: number
    medianPromptBytes: number | null
    sizeClasses: Record<string, number>
    modalSizeClass: number | null
  }>
  flagged: boolean
  reasons: string[]
}

export type RouteCostBacktestReport = { groups: CostBacktestGroup[]; fairness: FairnessCell[] }

/** Keep only evidence whose judgment or terminal failure existed before dispatch. */
export function causalEvidenceBefore<T extends { evidenceAt: string | null }>(
  rows: T[],
  decisionStartedAt: string,
): T[] {
  return rows.filter((row) => row.evidenceAt !== null && row.evidenceAt < decisionStartedAt)
}

function pickedCost(candidate: CostBacktestCandidate): number | null {
  return 'usd' in candidate.meanCostPerRun ? candidate.meanCostPerRun.usd : null
}

function isImputed(candidate: CostBacktestCandidate): boolean {
  return (
    ('usd' in candidate.meanCostPerRun && Boolean(candidate.meanCostPerRun.imputed)) ||
    ('usd' in candidate.costPerAccepted && Boolean(candidate.costPerAccepted.imputed))
  )
}

function evaluateDecision(decision: CostBacktestDecision, variant: CostBacktestVariant) {
  const baseline = decision.candidates.find((row) => row.agent === decision.baselineAgent)!
  const proven = decision.candidates.filter((candidate) => candidate.proven)
  const baselineProven = proven.find((candidate) => candidate.agent === baseline.agent)
  const selected = baselineProven
    ? selectByCostPolicy(proven, variant, NOISE_BAND, BETA_SCALE, baselineProven)
    : null
  const picked = selected?.chosen ?? baseline
  return {
    baseline,
    picked,
    baselineCost: pickedCost(baseline),
    pickedCost: pickedCost(picked),
    allBelowFloor: Boolean(selected?.floorIgnored),
    allCostsUnknown: selected ? selected.allCostsUnknown : proven.length === 0,
    imputed: isImputed(baseline) || isImputed(picked),
  }
}

function figure(
  decisions: CostBacktestDecision[],
  variant: CostBacktestVariant,
  windowDays: number,
): CostBacktestFigure {
  const evaluated = decisions.map((decision) => evaluateDecision(decision, variant))
  const shiftedRows = evaluated.filter((row) => row.picked.agent !== row.baseline.agent)
  const moves = new Map<string, number>()
  for (const row of shiftedRows) {
    const key = `${row.baseline.agent}\0${row.picked.agent}`
    moves.set(key, (moves.get(key) ?? 0) + 1)
  }
  const matchedCosts = evaluated.filter(
    (row) => row.baselineCost !== null && row.pickedCost !== null,
  )
  const accepted = evaluated.filter(
    (row) => row.baseline.acceptedShare !== null && row.picked.acceptedShare !== null,
  )
  const baselineUsd = matchedCosts.reduce((sum, row) => sum + row.baselineCost!, 0)
  const variantUsd = matchedCosts.reduce((sum, row) => sum + row.pickedCost!, 0)
  const baselineAccepted = accepted.reduce((sum, row) => sum + row.baseline.acceptedShare!, 0)
  const variantAccepted = accepted.reduce((sum, row) => sum + row.picked.acceptedShare!, 0)
  const n = decisions.length
  const acceptedN = accepted.length
  const scale = windowDays > 0 ? 7 / windowDays : 0
  return {
    variant,
    decisions: { n },
    routingShift: {
      n,
      count: shiftedRows.length,
      share: n ? shiftedRows.length / n : 0,
      moves: [...moves]
        .map(([key, count]) => {
          const [from, to] = key.split('\0')
          return { from: from!, to: to!, count }
        })
        .sort(
          (a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
        ),
    },
    usdPerWeek: {
      n: matchedCosts.length,
      baseline: baselineUsd * scale,
      variant: variantUsd * scale,
      delta: (variantUsd - baselineUsd) * scale,
      baselineUnpriced: evaluated.filter((row) => row.baselineCost === null).length,
      variantUnpriced: evaluated.filter((row) => row.pickedCost === null).length,
    },
    acceptedRate: {
      n: acceptedN,
      baseline: acceptedN ? baselineAccepted / acceptedN : 0,
      variant: acceptedN ? variantAccepted / acceptedN : 0,
      deltaPoints: acceptedN ? ((variantAccepted - baselineAccepted) / acceptedN) * 100 : 0,
    },
    fallbacks: {
      n,
      allBelowFloor: evaluated.filter((row) => row.allBelowFloor).length,
      allCostsUnknown: evaluated.filter((row) => row.allCostsUnknown).length,
      pickedOrBaselineImputed: evaluated.filter((row) => row.imputed).length,
    },
  }
}

export function fairnessReport(
  runs: FairnessRun[],
  provenAgents: Map<string, Set<string>>,
): FairnessCell[] {
  const cells = new Map<string, FairnessRun[]>()
  for (const run of runs) {
    const key = `${run.job}\0${run.promptBucket}\0${run.lens ?? ''}`
    const proven = provenAgents.get(key)
    if ((proven?.size ?? 0) < 2 || !proven?.has(run.agent)) continue
    cells.set(key, [...(cells.get(key) ?? []), run])
  }
  return [...cells].map(([key, rows]) => {
    const [job, promptBucket, rawLens] = key.split('\0')
    const agents = [...provenAgents.get(key)!].sort().map((agent) => {
      const agentRows = rows.filter((row) => row.agent === agent)
      const sizeClasses: Record<string, number> = {}
      for (const row of agentRows)
        if (row.sizeClass !== null)
          sizeClasses[String(row.sizeClass)] = (sizeClasses[String(row.sizeClass)] ?? 0) + 1
      const modal = Object.entries(sizeClasses).sort(
        ([aClass, aCount], [bClass, bCount]) => bCount - aCount || Number(aClass) - Number(bClass),
      )[0]
      return {
        agent,
        runs: agentRows.length,
        medianPromptBytes: median(agentRows.map((row) => row.promptBytes)),
        sizeClasses,
        modalSizeClass: modal ? Number(modal[0]) : null,
      }
    })
    const medians = agents.flatMap((agent) =>
      agent.medianPromptBytes !== null && agent.medianPromptBytes > 0
        ? [agent.medianPromptBytes]
        : [],
    )
    const promptRatio = medians.length > 1 ? Math.max(...medians) / Math.min(...medians) : 1
    const modes = new Set(
      agents.map((agent) => agent.modalSizeClass).filter((value) => value !== null),
    )
    const reasons = [
      ...(promptRatio > 1.5 ? [`median prompt bytes differ by ${promptRatio.toFixed(2)}x`] : []),
      ...(modes.size > 1 ? ['modal landed-diff size class differs'] : []),
    ]
    return {
      job: job!,
      promptBucket: promptBucket as PromptSizeBucket,
      lens: rawLens || null,
      agents,
      flagged: reasons.length > 0,
      reasons,
    }
  })
}

export function routeCostBacktest(
  decisions: CostBacktestDecision[],
  fairnessRuns: FairnessRun[],
  provenAgents: Map<string, Set<string>>,
  windowDays: number,
): RouteCostBacktestReport {
  const groups = [...new Set(decisions.map((decision) => decision.group))].sort().map((group) => {
    const rows = decisions.filter((decision) => decision.group === group)
    const variants = rows[0]?.variants ?? []
    return {
      group,
      n: rows.length,
      figures: variants.map((variant) => figure(rows, variant, windowDays)),
    }
  })
  return { groups, fairness: fairnessReport(fairnessRuns, provenAgents) }
}
