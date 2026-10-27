import { expect, test } from 'bun:test'
import { reportedRunCost } from '../run/run-subscription-cost.ts'
import { costPerAcceptedResult, routeCostPerAccepted } from './route-cost.ts'

const row = (usd: number | null, source = 'vendor') => ({ usd, source })

test('cost per accepted result prices a metered run', () => {
  expect(costPerAcceptedResult([{ accepted: true, rows: [row(0.25)] }])).toEqual({ usd: 0.25 })
})

test('cost per accepted result uses the amortized subscription price', () => {
  const cost = reportedRunCost({
    billing: 'subscription',
    billedUsd: null,
    storedSource: null,
    monthlyPriceUsd: 20,
    runTokens: 100,
    monthTokens: 1_000,
  })
  expect(costPerAcceptedResult([{ accepted: true, rows: [cost] }])).toEqual({ usd: 2 })
})

test('rejected runs still add to cost per accepted result', () => {
  expect(
    costPerAcceptedResult([
      { accepted: true, rows: [row(0.25)] },
      { accepted: false, rows: [row(0.75)] },
    ]),
  ).toEqual({ usd: 1 })
})

test('a writing chain adds fix-round turn costs to its root', () => {
  expect(
    costPerAcceptedResult([{ accepted: true, rows: [row(0.25), row(0.5), row(0.75)] }]),
  ).toEqual({ usd: 1.5 })
})

test('cost per accepted result is unknown without an accepted run', () => {
  expect(costPerAcceptedResult([{ accepted: false, rows: [row(0.25)] }])).toEqual({
    unknown: 'no accepted results',
  })
})

test('an unpriced subscription run names its unknown source', () => {
  const cost = reportedRunCost({
    billing: 'subscription',
    billedUsd: null,
    storedSource: null,
    monthlyPriceUsd: null,
    runTokens: 100,
    monthTokens: 100,
  })
  expect(costPerAcceptedResult([{ accepted: true, rows: [cost] }])).toEqual({
    unknown: 'subscription, unpriced',
  })
})

test('acceptance requires the job-specific score dimensions', () => {
  const costs = new Map([['root', [row(0.25)]]])
  const root = { record_id: 'root', delivery: 'full', quality: 'right', fidelity: 'drifted' }
  expect(routeCostPerAccepted('implement', [root], costs)).toEqual({
    unknown: 'no accepted results',
  })
  expect(routeCostPerAccepted('implement', [{ ...root, fidelity: 'faithful' }], costs)).toEqual({
    usd: 0.25,
  })
  expect(routeCostPerAccepted('review-lens', [{ ...root, fidelity: null }], costs)).toEqual({
    usd: 0.25,
  })
  for (const verdict of [{ delivery: 'partial' }, { quality: 'mixed' }]) {
    expect(routeCostPerAccepted('review-lens', [{ ...root, ...verdict }], costs)).toEqual({
      unknown: 'no accepted results',
    })
  }
})
