// concern: review-yield-cost
/** Computes cost and elapsed-time efficiency from already-priced lens runs. */

export const UNRECORDED_COST_SOURCE = '(not recorded)'

export type ReviewYieldCostRun = {
  costUsd: number | null
  costSource: string | null
  hits: number
  lensMinutes: number | null
}

export type ReviewYieldCost = {
  costUsd: number
  costSources: Record<string, number>
  pricedHits: number
  costPerHit: number | null
  lensMinutes: number
  minutesPerHit: number | null
}

export function reviewYieldCost(runs: readonly ReviewYieldCostRun[]): ReviewYieldCost {
  let costUsd = 0
  let pricedHits = 0
  let hits = 0
  let lensMinutes = 0
  const costSources: Record<string, number> = {}

  for (const run of runs) {
    const source = run.costSource ?? UNRECORDED_COST_SOURCE
    costSources[source] = (costSources[source] ?? 0) + 1
    hits += run.hits
    lensMinutes += run.lensMinutes ?? 0
    if (run.costUsd === null) continue
    costUsd += run.costUsd
    pricedHits += run.hits
  }

  return {
    costUsd,
    costSources,
    pricedHits,
    costPerHit: pricedHits ? costUsd / pricedHits : null,
    lensMinutes,
    minutesPerHit: hits ? lensMinutes / hits : null,
  }
}
