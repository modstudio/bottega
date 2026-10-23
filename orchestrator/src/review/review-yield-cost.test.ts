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
      timedHits: 5,
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
      timedHits: 0,
      minutesPerHit: null,
    })
  })

  test('excludes hits without a known duration from minutes per hit', () => {
    expect(
      reviewYieldCost([
        { costUsd: 2, costSource: 'billed', hits: 2, lensMinutes: 10 },
        { costUsd: 3, costSource: 'billed', hits: 3, lensMinutes: null },
      ]),
    ).toMatchObject({
      lensMinutes: 10,
      timedHits: 2,
      minutesPerHit: 5,
    })
  })
})
