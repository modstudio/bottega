import { describe, expect, test } from 'bun:test'
import {
  type CostPolicyQualityCandidate,
  DEFAULT_ROUTE_COST_POLICY,
  parseRouteCostPolicy,
  resolveRouteCostPolicy,
  selectByCostPolicy,
} from './route-cost-policy.ts'

const NOISE_BAND = 0.01
const BETA_SCALE = 1.5

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
  test('rate 1.25 rejects a three-point gain at 1.2x but accepts a ten-point gain at 1.4x', () => {
    const baseline = candidate('baseline', 90, 1)
    expect(select([baseline, candidate('small-gain', 93, 1.2)], 1.25).chosen.agent).toBe('baseline')
    expect(select([baseline, candidate('large-gain', 100, 1.4)], 1.25).chosen.agent).toBe(
      'large-gain',
    )
  })

  test('rate 1 picks the cheapest floor-eligible candidate', () => {
    expect(
      select([candidate('strong', 99, 2), candidate('cheap', 81, 1)], 1, 0.8).chosen.agent,
    ).toBe('cheap')
  })

  test('the floor includes its noise band, excludes a clear miss, and is ignored when all miss', () => {
    const withinNoise = candidate('within-noise', 79, 1, 0.79)
    const clearMiss = candidate('clear-miss', 95, 0.1, 0.78)
    expect(select([withinNoise, clearMiss], 1, 0.8).chosen.agent).toBe('within-noise')
    const allBelow = select([clearMiss, candidate('also-low', 70, 1, 0.7)], 1, 0.8)
    expect(allBelow.floorIgnored).toBe(true)
    expect(allBelow.chosen.agent).toBe('clear-miss')
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
