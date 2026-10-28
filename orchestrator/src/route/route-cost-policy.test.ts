import { describe, expect, test } from 'bun:test'
import {
  type CostPolicyQualityCandidate,
  DEFAULT_ROUTE_COST_POLICY,
  parseRouteCostPolicy,
  resolveRouteCostPolicy,
  selectByCostPolicy,
} from './route-cost-policy.ts'
import { BETA_SCALE, NOISE_BAND } from './route-selection.ts'

function candidate(
  agent: string,
  qualityPoints: number,
  cost: number | null,
  shrunk = qualityPoints / 100,
): CostPolicyQualityCandidate {
  return {
    agent,
    shrunk,
    qualityValue: qualityPoints / (BETA_SCALE * 100),
    costPerAccepted: cost === null ? { unknown: 'unpriced' } : { usd: cost },
    free: false,
    latencyMs: 1_000,
    evidence: 10,
  }
}

function select(
  candidates: CostPolicyQualityCandidate[],
  rate: number,
  floor: number | null = null,
  currentChoice = candidates[0]!,
) {
  return selectByCostPolicy(candidates, { rate, floor }, NOISE_BAND, BETA_SCALE, currentChoice)
}

describe('cost policy selection', () => {
  test('rate 1.25 charges premiums only for quality gains beyond production noise', () => {
    const equalCheap = candidate('equal-cheap', 80, 1)
    const equalExpensive = candidate('equal-expensive', 80, 1.5)
    const equal = select([equalExpensive, equalCheap], 1.25)
    expect(equal.chosen.agent).toBe('equal-cheap')
    expect(equal.tied).toBe(1)

    const baseline = candidate('baseline', 80, 1)
    const worthwhile = select([baseline, candidate('worthwhile', 96, 1.4)], 1.25)
    expect(worthwhile.chosen.agent).toBe('worthwhile')
    expect(worthwhile.tied).toBe(1)

    const excessive = select([baseline, candidate('excessive', 96, 2.1)], 1.25)
    expect(excessive.chosen.agent).toBe('baseline')
    expect(excessive.tied).toBe(1)
  })

  test('quality noise does not buy an eight-fold premium under the writing rate', () => {
    const cheap = candidate('cheap', 80, 1)
    const expensive = { ...candidate('expensive', 80, 8), free: true }
    const selected = select([expensive, cheap], 3)
    expect(selected.chosen.agent).toBe('cheap')
    expect(selected.tied).toBe(1)
  })

  test('rate 1 picks the cheapest floor-eligible candidate', () => {
    expect(
      select([candidate('strong', 99, 2), candidate('cheap', 81, 1)], 1, 0.8).chosen.agent,
    ).toBe('cheap')
  })

  test('the floor includes its noise band, excludes a clear miss, and is ignored when all miss', () => {
    const withinNoise = candidate('within-noise', 70, 1, 0.7)
    const clearMiss = candidate('clear-miss', 95, 0.1, 0.69)
    expect(select([withinNoise, clearMiss], 1, 0.8).chosen.agent).toBe('within-noise')
    const current = candidate('quality-choice', 95, 2, 0.69)
    const allBelow = select([current, candidate('cheap-low', 70, 0.1, 0.6)], 1, 0.8, current)
    expect(allBelow.floorIgnored).toBe(true)
    expect(allBelow.chosen.agent).toBe('quality-choice')
    expect(allBelow.chargedCost).toBe(2)
  })

  test('unknown cost is charged the field maximum and all unknown reproduces the current choice', () => {
    const known = candidate('known', 90, 2)
    const unknown = candidate('unknown', 90, null)
    const charged = select([known, unknown], 1, null, known)
    expect(charged.chargedCost).toBe(2)
    expect(charged.chosen.agent).toBe('known')

    const incumbent = candidate('incumbent', 90, null)
    const other = candidate('other', 99, null)
    const allUnknown = select([incumbent, other], 3, null, incumbent)
    expect(allUnknown.allCostsUnknown).toBe(true)
    expect(allUnknown.chosen).toBe(incumbent)
  })

  test('all-unknown costs replace a below-floor current choice with eligible best quality', () => {
    const belowFloor = candidate('below-floor', 99, null, 0.69)
    const eligible = candidate('eligible', 85, null, 0.8)
    const lowerEligible = candidate('lower-eligible', 75, null, 0.75)
    const selected = select([belowFloor, lowerEligible, eligible], 1.25, 0.8, belowFloor)
    expect(selected.allCostsUnknown).toBe(true)
    expect(selected.chosen).toBe(eligible)
  })
})

test('resolver applies a named lens tier and defaults an unlisted writing job to writing', () => {
  expect(resolveRouteCostPolicy(DEFAULT_ROUTE_COST_POLICY, 'review-lens', 'safety', false)).toEqual(
    {
      group: 'high-stakes',
      floor: 0.9,
      rate: 3,
    },
  )
  expect(resolveRouteCostPolicy(DEFAULT_ROUTE_COST_POLICY, 'new-writer', null, true)).toEqual({
    group: 'writing',
    floor: null,
    rate: 3,
  })
})

test('config deeply merges an override and refuses a bad field by name', () => {
  const policy = parseRouteCostPolicy(
    JSON.stringify({ enabled: true, groups: { review: { floor: 0.75 } } }),
  )
  expect(policy.enabled).toBe(true)
  expect(policy.groups.review).toEqual({ jobs: ['review-lens'], rate: 1.25, floor: 0.75 })
  expect(policy.groups.writing).toEqual(DEFAULT_ROUTE_COST_POLICY.groups.writing)
  expect(() => parseRouteCostPolicy(JSON.stringify({ groups: { review: { rate: 0.5 } } }))).toThrow(
    'routing.cost_policy field groups.review.rate',
  )
})
