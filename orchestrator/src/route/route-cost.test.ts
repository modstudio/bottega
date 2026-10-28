import { expect, test } from 'bun:test'
import { reportedRunCost } from '../run/run-subscription-cost.ts'
import { costPerAcceptedResult, routeCostPerAccepted, routeMeanCostPerRun } from './route-cost.ts'

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

test('mean cost per run divides equal-cost accepted and rejected chains by both runs', () => {
  const roots = [
    { record_id: 'accepted', delivery: 'full', quality: 'right', fidelity: null },
    { record_id: 'rejected', delivery: 'full', quality: 'mixed', fidelity: null },
  ]
  const costs = new Map([
    ['accepted', [row(0.25)]],
    ['rejected', [row(0.25)]],
  ])
  expect(routeMeanCostPerRun(roots, costs)).toEqual({ usd: 0.25 })
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

test('one unpriced row among priced rows is charged the priced mean and reported', () => {
  const result = costPerAcceptedResult([
    { accepted: true, rows: [row(0.2), row(null, 'none'), row(0.4)] },
  ])
  expect(result).toMatchObject({ imputed: 1 })
  expect('usd' in result ? result.usd : null).toBeCloseTo(0.9)
})

test('below half priced is unknown with the dominant unpriced source', () => {
  expect(
    costPerAcceptedResult([
      {
        accepted: true,
        rows: [row(0.2), row(null, 'none'), row(null, 'none'), row(null, 'estimated')],
      },
    ]),
  ).toEqual({ unknown: 'none' })
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
