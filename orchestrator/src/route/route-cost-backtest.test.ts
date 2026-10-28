import { describe, expect, test } from 'bun:test'
import {
  type CostBacktestCandidate,
  type CostBacktestDecision,
  causalEvidenceBefore,
  fairnessReport,
  routeCostBacktest,
} from './route-cost-backtest.ts'

const candidate = (
  agent: string,
  qualityValue: number,
  costPerAccepted: CostBacktestCandidate['costPerAccepted'],
  meanCostPerRun: CostBacktestCandidate['meanCostPerRun'],
  acceptedShare: number,
  shrunk = qualityValue,
): CostBacktestCandidate => ({
  agent,
  qualityValue,
  shrunk,
  costPerAccepted,
  meanCostPerRun,
  acceptedShare,
  evidence: 10,
  free: false,
  latencyMs: 100,
})

const variant = { name: 'test', rate: 1, floor: 0.75, shippedDefault: false }
const decision = (
  candidates: CostBacktestCandidate[],
  baselineAgent = 'strong',
): CostBacktestDecision => ({
  job: 'review-lens',
  promptBucket: '<16 KiB',
  lens: 'craft',
  group: 'review',
  baselineAgent,
  candidates,
  variants: [variant],
})

describe('route cost backtest', () => {
  test('aggregates shifts, deltas, unpriced picks, and fallback states', () => {
    const shifted = decision([
      candidate('strong', 0.6, { usd: 2 }, { usd: 1 }, 0.9, 0.8),
      candidate('cheap', 0.6, { usd: 1 }, { usd: 0.5 }, 0.8, 0.8),
    ])
    const unpriced = decision([
      candidate('strong', 0.6, { unknown: 'unpriced' }, { unknown: 'unpriced' }, 0.7, 0.8),
      candidate('cheap', 0.5, { unknown: 'unpriced' }, { unknown: 'unpriced' }, 0.6, 0.8),
    ])
    const below = decision([
      candidate('strong', 0.5, { usd: 2 }, { usd: 1, imputed: 1 }, 0.7),
      candidate('cheap', 0.4, { usd: 1 }, { usd: 0.5 }, 0.6),
    ])
    const report = routeCostBacktest([shifted, unpriced, below], [], new Map(), 7)
    const figure = report.groups[0]!.figures[0]!
    expect(figure.routingShift).toMatchObject({ n: 3, count: 1, share: 1 / 3 })
    expect(figure.routingShift.moves).toEqual([{ from: 'strong', to: 'cheap', count: 1 }])
    expect(figure.usdPerWeek).toMatchObject({
      n: 3,
      baseline: 2,
      variant: 1.5,
      delta: -0.5,
      baselineUnpriced: 1,
      variantUnpriced: 1,
    })
    expect(figure.acceptedRate.deltaPoints).toBeCloseTo(-10 / 3)
    expect(figure.fallbacks).toEqual({
      n: 3,
      allBelowFloor: 1,
      allCostsUnknown: 1,
      pickedOrBaselineImputed: 1,
    })
  })

  test('excludes a judgment recorded after the decision started', () => {
    const rows = [
      { id: 'before', evidenceAt: '2026-10-28T09:59:00.000Z' },
      { id: 'after', evidenceAt: '2026-10-28T10:01:00.000Z' },
      { id: 'never', evidenceAt: null },
    ]
    expect(causalEvidenceBefore(rows, '2026-10-28T10:00:00.000Z').map((row) => row.id)).toEqual([
      'before',
    ])
  })
})

describe('cost backtest fairness', () => {
  const runs = (secondPrompt: number) => [
    {
      job: 'implement',
      promptBucket: '<16 KiB',
      lens: null,
      agent: 'a',
      promptBytes: 1000,
      sizeClass: 1,
    },
    {
      job: 'implement',
      promptBucket: '<16 KiB',
      lens: null,
      agent: 'b',
      promptBytes: secondPrompt,
      sizeClass: 1,
    },
  ]
  const proven = new Map([['implement\0<16 KiB\0', new Set(['a', 'b'])]])

  test('flags a 1.6x prompt mix difference', () => {
    expect(fairnessReport(runs(1600), proven)[0]).toMatchObject({ flagged: true })
  })

  test('does not flag a 1.4x prompt mix difference', () => {
    expect(fairnessReport(runs(1400), proven)[0]).toMatchObject({ flagged: false })
  })
})
