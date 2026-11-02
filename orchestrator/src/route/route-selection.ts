// concern: route selection
/** Pure incumbent and cost-aware ranking over an already admitted candidate field. */

import { FIDELITY_PENALTY, WEIGHT, weigh } from '../score/score.ts'
import { type CostPolicySelection, costAwareRank } from './route-cost-policy.ts'
import {
  type PolicyCandidate,
  type PolicySelection,
  rankThompson,
  selectCurrentPolicy,
} from './route-policy.ts'

export const MIN_SAMPLE = 5
const EXPLORE_RATE = 0.25
export const STANDING_EXPLORE_RATE = 0.1
const STANDING_EXPLORE_FLOOR = 0.03

export function standingExploreRate(leaderEvidence: number): number {
  return Math.max(
    STANDING_EXPLORE_FLOOR,
    STANDING_EXPLORE_RATE / Math.sqrt(leaderEvidence / MIN_SAMPLE),
  )
}

export const QUALITY_STEP = weigh('full', 'right') - weigh('full', 'mixed')
export const NOISE_BAND = QUALITY_STEP / MIN_SAMPLE
export const BETA_SCALE = 1.5
export const POSTERIOR_NOISE_BAND = NOISE_BAND / BETA_SCALE

export function betaContribution(weight: number): { successes: number; failures: number } {
  const successes = (weight + 0.5) / BETA_SCALE
  return { successes, failures: 1 - successes }
}

type ThompsonCandidate = Pick<
  PolicyCandidate,
  'agent' | 'evidence' | 'score' | 'free' | 'latencyMs'
> & { precision?: number | null }

export function thompsonRank<T extends ThompsonCandidate>(
  candidates: readonly T[],
  draw = true,
  rng: () => number = Math.random,
) {
  return rankThompson(candidates, draw, rng, MIN_SAMPLE, betaContribution, POSTERIOR_NOISE_BAND)
}

export function weightCase(alias = 's'): string {
  const arms: string[] = []
  for (const [delivery, row] of Object.entries(WEIGHT)) {
    if (typeof row === 'number') arms.push(`WHEN ${alias}.delivery = '${delivery}' THEN ${row}`)
    else
      for (const [quality, weight] of Object.entries(row))
        arms.push(
          `WHEN ${alias}.delivery = '${delivery}' AND ${alias}.quality = '${quality}' THEN ${weight}`,
        )
  }
  const penalty = Object.entries(FIDELITY_PENALTY)
    .map(([fidelity, weight]) => `WHEN ${alias}.fidelity = '${fidelity}' THEN ${weight}`)
    .join(' ')
  return `MAX((CASE ${arms.join(' ')} ELSE 0 END) + (CASE ${penalty} ELSE 0 END), ${WEIGHT.none as number})`
}

type PricedPolicyCandidate = PolicyCandidate & {
  costPerAccepted: { usd: number } | { unknown: string }
}
export type CurrentPolicySelection<T extends PolicyCandidate> = PolicySelection<T> & {
  costPolicy?: CostPolicySelection<T>
}

export function currentPolicySelection<T extends PolicyCandidate>(
  candidates: readonly T[],
  prefer: readonly string[],
  explore = true,
  rng: () => number = Math.random,
  explorationExcluded: ReadonlySet<string> = new Set(),
  declaredPreferences: ReadonlySet<string> = new Set(),
  costPolicy?: { enabled: boolean; rate: number; floor: number | null },
): CurrentPolicySelection<T> {
  let costSelection: CostPolicySelection<T> | undefined
  const selected = selectCurrentPolicy(
    candidates,
    prefer,
    explore,
    rng,
    explorationExcluded,
    declaredPreferences,
    {
      minSample: MIN_SAMPLE,
      exploreRate: EXPLORE_RATE,
      standingExploreRate,
      rank: (proven, draw, rankRng) => {
        if (!costPolicy?.enabled) return thompsonRank(proven, draw, rankRng)
        const ranked = costAwareRank(
          proven as readonly (T & PricedPolicyCandidate)[],
          draw,
          rankRng,
          costPolicy,
          NOISE_BAND,
          BETA_SCALE,
          thompsonRank,
        )
        costSelection = ranked.costPolicy as CostPolicySelection<T>
        return ranked
      },
    },
  )
  return costSelection ? { ...selected, costPolicy: costSelection } : selected
}
