import { describe, expect, test } from 'bun:test'
import {
  amortizedSubscriptionShare,
  harnessFromSubscriptionPriceKey,
  reportedCostForRun,
  reportedRunCost,
  SUBSCRIPTION_AMORTIZED_SOURCE,
  SUBSCRIPTION_UNPRICED_SOURCE,
  subscriptionMonthlyUsdKey,
} from './run-subscription-cost.ts'

describe('amortizedSubscriptionShare', () => {
  test('is the run tokens over the month tokens times the monthly price', () => {
    expect(
      amortizedSubscriptionShare({ monthlyPriceUsd: 100, runTokens: 1, monthTokens: 4 }),
    ).toEqual({ usd: 25, source: SUBSCRIPTION_AMORTIZED_SOURCE })
  })

  test('shares in one month sum to the price', () => {
    const month = [
      amortizedSubscriptionShare({ monthlyPriceUsd: 100, runTokens: 1, monthTokens: 10 }),
      amortizedSubscriptionShare({ monthlyPriceUsd: 100, runTokens: 2, monthTokens: 10 }),
      amortizedSubscriptionShare({ monthlyPriceUsd: 100, runTokens: 7, monthTokens: 10 }),
    ]
    expect(month.map((share) => share.usd)).toEqual([10, 20, 70])
    expect(month.reduce((sum, share) => sum + (share.usd ?? 0), 0)).toBe(100)
    expect(month.every((share) => share.source === SUBSCRIPTION_AMORTIZED_SOURCE)).toBe(true)
  })

  test('the unpriced case has no dollar figure', () => {
    expect(
      amortizedSubscriptionShare({ monthlyPriceUsd: null, runTokens: 40, monthTokens: 80 }),
    ).toEqual({ usd: null, source: SUBSCRIPTION_UNPRICED_SOURCE })
  })
})

describe('reportedRunCost', () => {
  test("a subscription run's stored estimate is ignored by the reader", () => {
    expect(
      reportedRunCost({
        billing: 'subscription',
        billedUsd: 23.5,
        estimatedUsd: 23.5,
        storedSource: 'estimated',
        monthlyPriceUsd: 100,
        runTokens: 1,
        monthTokens: 4,
      }),
    ).toEqual({ usd: 25, source: SUBSCRIPTION_AMORTIZED_SOURCE })
  })

  test('a metered run keeps billed cost', () => {
    expect(
      reportedRunCost({
        billing: 'metered',
        billedUsd: 0.11,
        estimatedUsd: null,
        storedSource: 'billed',
        monthlyPriceUsd: 200,
        runTokens: 111,
        monthTokens: 111,
      }),
    ).toEqual({ usd: 0.11, source: 'billed' })
  })
})

test('reportedCostForRun ignores a stored estimate on a subscription agent', () => {
  expect(
    reportedCostForRun(
      {
        agent: 'grok',
        startedAt: '2026-10-22T13:00:00.000Z',
        vendorTokens: 1,
        vendorCostUsd: null,
        vendorEstimatedCostUsd: 23.5,
        vendorCostSource: 'estimated',
      },
      {
        agents: { grok: { billing: 'subscription', harness: 'grok' } },
        monthTokens: { 'grok:2026-10': 4 },
      },
      { grok: 100 },
    ),
  ).toEqual({ usd: 25, source: SUBSCRIPTION_AMORTIZED_SOURCE })
})

test('subscription price keys are named for the harness', () => {
  expect(subscriptionMonthlyUsdKey('codex')).toBe('subscription.codex.monthly_usd')
  expect(harnessFromSubscriptionPriceKey('subscription.grok.monthly_usd')).toBe('grok')
  expect(harnessFromSubscriptionPriceKey('autonomy.ship-to')).toBeNull()
})
