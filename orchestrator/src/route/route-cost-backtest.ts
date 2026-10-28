// concern: route cost backtest
/** Pure aggregation of causal routing snapshots under cost-policy variants. */

import type { CostPolicyRule } from './route-cost-policy.ts'
import { selectByCostPolicy } from './route-cost-policy.ts'
import { BETA_SCALE, NOISE_BAND } from './route-selection.ts'

export type CostBacktestCandidate = {
  agent: string
  qualityValue: number
  shrunk: number | null
  costPerAccepted: { usd: number; imputed?: number } | { unknown: string }
  meanCostPerRun: { usd: number; imputed?: number } | { unknown: string }
  acceptedShare: number
  evidence: number
  free: boolean
  latencyMs: number | null
}

export type CostBacktestVariant = CostPolicyRule & { name: string; shippedDefault: boolean }

export type CostBacktestDecision = {
  job: string
  promptBucket: string
  lens: string | null
  group: string
  baselineAgent: string
  candidates: CostBacktestCandidate[]
  variants: CostBacktestVariant[]
}

export type CostBacktestFigure = {
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

export type CostBacktestGroup = { group: string; n: number; figures: CostBacktestFigure[] }

export type FairnessRun = {
  job: string
  promptBucket: string
  lens: string | null
  agent: string
  promptBytes: number
  sizeClass: number | null
}

export type FairnessCell = {
  job: string
  promptBucket: string
  lens: string | null
  agents: Array<{
    agent: string
    runs: number
    medianPromptBytes: number
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

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function pickedCost(candidate: CostBacktestCandidate): number | null {
  return 'usd' in candidate.meanCostPerRun ? candidate.meanCostPerRun.usd : null
}

function figure(
  decisions: CostBacktestDecision[],
  variant: CostBacktestVariant,
  windowDays: number,
): CostBacktestFigure {
  let shifted = 0
  let baselineUsd = 0
  let variantUsd = 0
  let baselineUnpriced = 0
  let variantUnpriced = 0
  let baselineAccepted = 0
  let variantAccepted = 0
  let allBelowFloor = 0
  let allCostsUnknown = 0
  let pickedOrBaselineImputed = 0
  const moves = new Map<string, number>()
  for (const decision of decisions) {
    const baseline = decision.candidates.find((row) => row.agent === decision.baselineAgent)!
    const selected = selectByCostPolicy(
      decision.candidates,
      variant,
      NOISE_BAND,
      BETA_SCALE,
      baseline,
    )
    const picked = selected.chosen
    if (picked.agent !== baseline.agent) {
      shifted++
      const key = `${baseline.agent}\0${picked.agent}`
      moves.set(key, (moves.get(key) ?? 0) + 1)
    }
    const baselineCost = pickedCost(baseline)
    const variantCost = pickedCost(picked)
    if (baselineCost === null) baselineUnpriced++
    else baselineUsd += baselineCost
    if (variantCost === null) variantUnpriced++
    else variantUsd += variantCost
    baselineAccepted += baseline.acceptedShare
    variantAccepted += picked.acceptedShare
    if (selected.floorIgnored) allBelowFloor++
    if (selected.allCostsUnknown) allCostsUnknown++
    if (
      ('usd' in baseline.meanCostPerRun && baseline.meanCostPerRun.imputed) ||
      ('usd' in picked.meanCostPerRun && picked.meanCostPerRun.imputed) ||
      ('usd' in baseline.costPerAccepted && baseline.costPerAccepted.imputed) ||
      ('usd' in picked.costPerAccepted && picked.costPerAccepted.imputed)
    )
      pickedOrBaselineImputed++
  }
  const n = decisions.length
  const scale = windowDays > 0 ? 7 / windowDays : 0
  return {
    variant,
    decisions: { n },
    routingShift: {
      n,
      count: shifted,
      share: n ? shifted / n : 0,
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
      n,
      baseline: baselineUsd * scale,
      variant: variantUsd * scale,
      delta: (variantUsd - baselineUsd) * scale,
      baselineUnpriced,
      variantUnpriced,
    },
    acceptedRate: {
      n,
      baseline: n ? baselineAccepted / n : 0,
      variant: n ? variantAccepted / n : 0,
      deltaPoints: n ? ((variantAccepted - baselineAccepted) / n) * 100 : 0,
    },
    fallbacks: { n, allBelowFloor, allCostsUnknown, pickedOrBaselineImputed },
  }
}

export function fairnessReport(
  runs: FairnessRun[],
  provenAgents: Map<string, Set<string>>,
): FairnessCell[] {
  const cells = new Map<string, FairnessRun[]>()
  for (const run of runs) {
    const key = `${run.job}\0${run.promptBucket}\0${run.lens ?? ''}`
    if ((provenAgents.get(key)?.size ?? 0) < 2) continue
    cells.set(key, [...(cells.get(key) ?? []), run])
  }
  return [...cells].map(([key, rows]) => {
    const [job, promptBucket, rawLens] = key.split('\0')
    const agents = [...new Set(rows.map((row) => row.agent))].sort().map((agent) => {
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
    const medians = agents.map((agent) => agent.medianPromptBytes).filter((value) => value > 0)
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
      promptBucket: promptBucket!,
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
