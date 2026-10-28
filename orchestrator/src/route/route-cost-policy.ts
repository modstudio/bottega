// concern: route cost policy
/** Pure configuration, resolution, and proven-candidate selection for cost-aware routing. */

import { routeCandidateTieOrder } from './route-policy.ts'

/** A cost difference under five percent is noise. */
const COST_NOISE_MULTIPLE = 1.05

export type CostPolicyRule = { rate: number; floor: number | null }
type CostPolicyGroup = CostPolicyRule & { jobs: string[] }
type CostPolicyLensTier = CostPolicyRule & { lenses: string[] }
export type RouteCostPolicy = {
  enabled: boolean
  groups: {
    writing: CostPolicyGroup
    review: CostPolicyGroup
    light: CostPolicyGroup
  }
  lensTiers: {
    'high-stakes': CostPolicyLensTier
    standard: CostPolicyLensTier
  }
}

export const DEFAULT_ROUTE_COST_POLICY: RouteCostPolicy = {
  enabled: false,
  groups: {
    writing: { jobs: ['implement', 'fix', 'issue-worker'], rate: 3, floor: null },
    review: { jobs: ['review-lens'], rate: 1.25, floor: 0.8 },
    light: {
      jobs: ['verify-claim', 'summarize', 'file-question', 'canon-lookup'],
      rate: 1,
      floor: 0.8,
    },
  },
  lensTiers: {
    'high-stakes': {
      lenses: [
        'correctness',
        'safety',
        'migration-safety',
        'teardown-safety',
        'backend-bug-hunting',
        'frontend-bug-hunting',
      ],
      rate: 3,
      floor: 0.9,
    },
    standard: {
      lenses: ['architecture', 'decision-conformance', 'test-quality'],
      rate: 1.5,
      floor: 0.8,
    },
  },
}

type JsonObject = Record<string, unknown>

function objectAt(value: unknown, field: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`routing.cost_policy field ${field} must be an object`)
  return value as JsonObject
}

function knownFields(value: JsonObject, fields: readonly string[], path: string): void {
  const unknown = Object.keys(value).find((field) => !fields.includes(field))
  if (unknown) throw new Error(`routing.cost_policy has unknown field ${path}.${unknown}`)
}

function optionalBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean')
    throw new Error(`routing.cost_policy field ${field} must be a boolean`)
  return value
}

function optionalStrings(value: unknown, fallback: string[], field: string): string[] {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim()))
    throw new Error(`routing.cost_policy field ${field} must be an array of non-empty strings`)
  return [...new Set(value)] as string[]
}

function optionalRate(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1)
    throw new Error(`routing.cost_policy field ${field} must be a finite number at least 1`)
  return value
}

function optionalFloor(value: unknown, fallback: number | null, field: string): number | null {
  if (value === undefined) return fallback
  if (
    value !== null &&
    (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
  )
    throw new Error(`routing.cost_policy field ${field} must be null or a number from 0 to 1`)
  return value
}

function mergeRule<T extends CostPolicyGroup | CostPolicyLensTier>(
  value: unknown,
  fallback: T,
  field: string,
  list: 'jobs' | 'lenses',
): T {
  if (value === undefined) return structuredClone(fallback)
  const object = objectAt(value, field)
  knownFields(object, [list, 'rate', 'floor'], field)
  const fallbackList =
    list === 'jobs' ? (fallback as CostPolicyGroup).jobs : (fallback as CostPolicyLensTier).lenses
  return {
    [list]: optionalStrings(object[list], fallbackList, `${field}.${list}`),
    rate: optionalRate(object.rate, fallback.rate, `${field}.rate`),
    floor: optionalFloor(object.floor, fallback.floor, `${field}.floor`),
  } as T
}

/** Parse the machine-config JSON and deeply merge its declared fields over the default policy. */
export function parseRouteCostPolicy(raw: string): RouteCostPolicy {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('routing.cost_policy must be valid JSON')
  }
  const root = objectAt(parsed, 'root')
  knownFields(root, ['enabled', 'groups', 'lensTiers'], 'root')
  const groups = root.groups === undefined ? {} : objectAt(root.groups, 'groups')
  knownFields(groups, ['writing', 'review', 'light'], 'groups')
  const lensTiers = root.lensTiers === undefined ? {} : objectAt(root.lensTiers, 'lensTiers')
  knownFields(lensTiers, ['high-stakes', 'standard'], 'lensTiers')
  return {
    enabled: optionalBoolean(root.enabled, DEFAULT_ROUTE_COST_POLICY.enabled, 'enabled'),
    groups: {
      writing: mergeRule(
        groups.writing,
        DEFAULT_ROUTE_COST_POLICY.groups.writing,
        'groups.writing',
        'jobs',
      ),
      review: mergeRule(
        groups.review,
        DEFAULT_ROUTE_COST_POLICY.groups.review,
        'groups.review',
        'jobs',
      ),
      light: mergeRule(
        groups.light,
        DEFAULT_ROUTE_COST_POLICY.groups.light,
        'groups.light',
        'jobs',
      ),
    },
    lensTiers: {
      'high-stakes': mergeRule(
        lensTiers['high-stakes'],
        DEFAULT_ROUTE_COST_POLICY.lensTiers['high-stakes'],
        'lensTiers.high-stakes',
        'lenses',
      ),
      standard: mergeRule(
        lensTiers.standard,
        DEFAULT_ROUTE_COST_POLICY.lensTiers.standard,
        'lensTiers.standard',
        'lenses',
      ),
    },
  }
}

export type ResolvedCostPolicy = CostPolicyRule & {
  group: 'writing' | 'review' | 'light' | 'high-stakes' | 'standard'
}

export function resolveRouteCostPolicy(
  policy: RouteCostPolicy,
  job: string,
  lens: string | null,
  writesRepo: boolean,
): ResolvedCostPolicy {
  if (lens) {
    for (const group of ['high-stakes', 'standard'] as const) {
      const rule = policy.lensTiers[group]
      if (rule.lenses.includes(lens)) return { group, floor: rule.floor, rate: rule.rate }
    }
  }
  for (const group of ['writing', 'review', 'light'] as const) {
    const rule = policy.groups[group]
    if (rule.jobs.includes(job)) return { group, floor: rule.floor, rate: rule.rate }
  }
  const group = writesRepo ? 'writing' : 'review'
  const rule = policy.groups[group]
  return { group, floor: rule.floor, rate: rule.rate }
}

export function findingsPolicyLens(findings: boolean, lens: string | undefined): string | null {
  return findings ? lens?.trim() || null : null
}

export function belowCostFloor(
  shrunk: number | null,
  floor: number | null,
  noiseBand: number,
): boolean {
  return floor !== null && shrunk !== null && shrunk < floor - noiseBand
}

export type CostPolicyCandidate = {
  agent: string
  shrunk: number | null
  costPerAccepted: { usd: number } | { unknown: string }
  precision?: number | null
  free: boolean
  latencyMs: number | null
  evidence: number
}
export type CostPolicyQualityCandidate = CostPolicyCandidate & { qualityValue: number }

export type CostPolicySelection<T> = {
  chosen: T
  tied: number
  floorIgnored: boolean
  allCostsUnknown: boolean
  chargedCost: number | null
}

export function costAwareRank<T extends CostPolicyCandidate>(
  candidates: readonly T[],
  draw: boolean,
  rng: () => number,
  rule: CostPolicyRule,
  noiseBand: number,
  betaScale: number,
  rank: (
    candidates: readonly T[],
    draw: boolean,
    rng: () => number,
  ) => {
    chosen: T
    tied: number
    posterior: Array<{ candidate: T; mean: number; sample: number }>
  },
): ReturnType<typeof rank> & { costPolicy: CostPolicySelection<T> } {
  const current = rank(candidates, draw, rng)
  const posterior = current.posterior.map((row) => ({
    ...row.candidate,
    qualityValue: draw ? row.sample : row.mean,
  }))
  const costPolicy = selectByCostPolicy(
    posterior,
    rule,
    noiseBand,
    betaScale,
    posterior.find((row) => row.agent === current.chosen.agent)!,
  )
  if (costPolicy.floorIgnored)
    return { ...current, costPolicy: costPolicy as CostPolicySelection<T> }
  return {
    ...current,
    chosen: costPolicy.chosen as T,
    tied: costPolicy.tied,
    costPolicy: costPolicy as CostPolicySelection<T>,
  }
}

type ExplainableCandidate = CostPolicyCandidate & {
  costPerAccepted: { usd: number; imputed?: number } | { unknown: string }
}

function costPhrase(value: ExplainableCandidate['costPerAccepted']): string {
  return 'usd' in value ? `$${value.usd.toFixed(3)} per accepted` : `cost ${value.unknown}`
}

function costPolicyReason<T extends ExplainableCandidate>(
  enabled: boolean,
  selection: { chosen: T; costPolicy?: CostPolicySelection<T> },
  incumbent: T,
  resolved: ResolvedCostPolicy,
  lens: string | null,
): string {
  const chosen = selection.chosen
  const score = (candidate: T) =>
    candidate.shrunk === null ? 'unproven' : `${(candidate.shrunk * 100).toFixed(0)}%`
  const comparison =
    chosen.agent === incumbent.agent
      ? `${score(chosen)}, ${costPhrase(chosen.costPerAccepted)}`
      : `${score(chosen)} vs ${score(incumbent)}, ` +
        `${costPhrase(chosen.costPerAccepted)} vs ${costPhrase(incumbent.costPerAccepted)}`
  const ignored = selection.costPolicy?.floorIgnored ? '; all proven candidates below floor' : ''
  const cell = lens ? `${lens}, ${resolved.group}` : resolved.group
  return (
    `cost policy (${enabled ? 'on' : 'off'}): ${enabled ? 'picked' : 'would pick'} ` +
    `${chosen.agent} — ${comparison}, rate ${resolved.rate}x/+5 (${cell})${ignored}`
  )
}

export function costPolicyExplanation<T extends ExplainableCandidate>(input: {
  priced: boolean
  enabled: boolean
  selected: { chosen: T; costPolicy?: CostPolicySelection<T> }
  hypothetical: () => { chosen: T; costPolicy?: CostPolicySelection<T> }
  resolved: ResolvedCostPolicy
  lens: string | null
}): string | null {
  if (!input.priced) return null
  const selection = input.enabled ? input.selected : input.hypothetical()
  return costPolicyReason(
    input.enabled,
    selection,
    input.selected.chosen,
    input.resolved,
    input.lens,
  )
}

export function appendCostPolicyReason(
  base: string,
  costReason: string | null,
  carried: boolean,
): string {
  if (!costReason || carried) return base
  return `${base}; ${costReason}`
}

/** Select among proven candidates by the configured quality-for-cost utility. */
export function selectByCostPolicy<T extends CostPolicyQualityCandidate>(
  candidates: readonly T[],
  rule: CostPolicyRule,
  noiseBand: number,
  betaScale: number,
  currentChoice: T,
): CostPolicySelection<T> {
  const floorEligible = candidates.filter(
    (candidate) => !belowCostFloor(candidate.shrunk, rule.floor, noiseBand),
  )
  const floorIgnored = floorEligible.length === 0
  if (floorIgnored)
    return {
      chosen: currentChoice,
      tied: 1,
      floorIgnored: true,
      allCostsUnknown: candidates.every((candidate) => !('usd' in candidate.costPerAccepted)),
      chargedCost:
        'usd' in currentChoice.costPerAccepted ? currentChoice.costPerAccepted.usd : null,
    }

  const known = floorEligible.flatMap((candidate) =>
    'usd' in candidate.costPerAccepted ? [candidate.costPerAccepted.usd] : [],
  )
  if (known.length === 0) {
    const currentEligible = floorEligible.find(
      (candidate) => candidate.agent === currentChoice.agent,
    )
    const bestQuality = Math.max(...floorEligible.map((candidate) => candidate.qualityValue))
    const qualityTied = floorEligible
      .filter((candidate) => candidate.qualityValue === bestQuality)
      .sort(routeCandidateTieOrder)
    const chosen = currentEligible ?? qualityTied[0]!
    return {
      chosen,
      tied: currentEligible ? 1 : qualityTied.length,
      floorIgnored: false,
      allCostsUnknown: true,
      chargedCost: null,
    }
  }
  const maximumCost = Math.max(...known)
  const utility = floorEligible.map((candidate) => {
    const cost = 'usd' in candidate.costPerAccepted ? candidate.costPerAccepted.usd : maximumCost
    const qualityPoints = candidate.qualityValue * betaScale * 100
    return {
      candidate,
      cost,
      value: (qualityPoints / 5) * Math.log(rule.rate) - Math.log(Math.max(cost, Number.EPSILON)),
    }
  })
  /** NOISE_BAND is in shrunk-score units; a quality value is that score over the beta scale. */
  const qualityNoise = noiseBand / betaScale
  const bestValue = Math.max(...utility.map((row) => row.value))
  const utilityBest = utility
    .filter((row) => row.value === bestValue)
    .sort((a, b) => routeCandidateTieOrder(a.candidate, b.candidate))[0]!
  const cheaper = utility.filter(
    (row) =>
      row.candidate.qualityValue >= utilityBest.candidate.qualityValue - qualityNoise &&
      row.cost * COST_NOISE_MULTIPLE < utilityBest.cost,
  )
  let provisional = utilityBest
  if (cheaper.length > 0) {
    const cheapestCost = Math.min(...cheaper.map((row) => row.cost))
    provisional = cheaper
      .filter((row) => row.cost === cheapestCost)
      .sort((a, b) => routeCandidateTieOrder(a.candidate, b.candidate))[0]!
  }
  const withinNoise = (left: (typeof utility)[number], right: (typeof utility)[number]) =>
    Math.abs(left.candidate.qualityValue - right.candidate.qualityValue) <= qualityNoise &&
    Math.max(left.cost, right.cost) <= Math.min(left.cost, right.cost) * COST_NOISE_MULTIPLE
  const chosen = utility
    .filter((row) => withinNoise(row, provisional))
    .sort((a, b) => routeCandidateTieOrder(a.candidate, b.candidate))[0]!
  const tied = utility.filter((row) => withinNoise(row, chosen)).length
  return {
    chosen: chosen.candidate,
    tied,
    floorIgnored: false,
    allCostsUnknown: false,
    chargedCost: chosen.cost,
  }
}
