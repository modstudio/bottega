import { describe, expect, test } from 'bun:test'
import { reviewYieldCost, UNRECORDED_COST_SOURCE } from './review-yield-cost.ts'

describe('review yield cost', () => {
  test('excludes unpriced runs and their hits from both sides of cost per hit', () => {
    expect(
      reviewYieldCost([
        { costUsd: 6, costSource: 'billed', hits: 2, lensMinutes: 12 },
        { costUsd: null, costSource: 'subscription, unpriced', hits: 3, lensMinutes: 18 },
      ]),
    ).toEqual({
      costUsd: 6,
      costSources: { billed: 1, 'subscription, unpriced': 1 },
      pricedHits: 2,
      costPerHit: 3,
      lensMinutes: 30,
      minutesPerHit: 6,
    })
  })

  test('returns null ratios for zero hits and counts a missing cost source', () => {
    expect(
      reviewYieldCost([{ costUsd: null, costSource: null, hits: 0, lensMinutes: null }]),
    ).toEqual({
      costUsd: 0,
      costSources: { [UNRECORDED_COST_SOURCE]: 1 },
      pricedHits: 0,
      costPerHit: null,
      lensMinutes: 0,
      minutesPerHit: null,
    })
  })
})
