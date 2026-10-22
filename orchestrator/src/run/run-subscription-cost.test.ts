import { describe, expect, test } from 'bun:test'
import {
  amortizedSubscriptionShare,
  reportedRunCost,
  SUBSCRIPTION_AMORTIZED_SOURCE,
  SUBSCRIPTION_NO_TOKENS_SOURCE,
  SUBSCRIPTION_PRICE_UNAVAILABLE_SOURCE,
  SUBSCRIPTION_UNPRICED_SOURCE,
  subscriptionMonthlyUsdKey,
  withReportedCost,
} from './run-subscription-cost.ts'

const grokContext = {
  facts: {
    agents: { grok: { billing: 'subscription' as const, harness: 'grok' } },
    monthTokens: { 'grok:2026-10': 4 },
  },
  prices: { grok: 100 },
}

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

  test('null run tokens give no figure', () => {
    expect(
      amortizedSubscriptionShare({ monthlyPriceUsd: 100, runTokens: null, monthTokens: 80 }),
    ).toEqual({ usd: null, source: SUBSCRIPTION_NO_TOKENS_SOURCE })
  })
})

describe('reportedRunCost', () => {
  test("a subscription run's stored estimate is ignored by the reader", () => {
    expect(
      reportedRunCost({
        billing: 'subscription',
        billedUsd: 23.5,
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
        storedSource: 'billed',
        monthlyPriceUsd: 200,
        runTokens: 111,
        monthTokens: 111,
      }),
    ).toEqual({ usd: 0.11, source: 'billed' })
  })
})

test('the shared row adapter returns cost fields and keeps the stored columns', () => {
  expect(
    withReportedCost(
      {
        agent: 'grok',
        started_at: '2026-10-22T13:00:00.000Z',
        vendor_tokens: 1,
        vendor_cost_usd: null,
        vendor_estimated_cost_usd: 23.5,
        vendor_cost_source: 'estimated',
      },
      grokContext,
    ),
  ).toEqual({
    agent: 'grok',
    started_at: '2026-10-22T13:00:00.000Z',
    vendor_tokens: 1,
    vendor_cost_usd: null,
    vendor_estimated_cost_usd: 23.5,
    vendor_cost_source: 'estimated',
    cost_usd: 25,
    cost_source: SUBSCRIPTION_AMORTIZED_SOURCE,
  })
})

test('an unread price is not reported as unpriced', () => {
  expect(
    withReportedCost(
      {
        agent: 'grok',
        started_at: '2026-10-22T13:00:00.000Z',
        vendor_tokens: 1,
        vendor_cost_usd: null,
        vendor_estimated_cost_usd: 23.5,
        vendor_cost_source: 'estimated',
      },
      {
        ...grokContext,
        prices: {},
        unavailable: { grok: 'hosted config is not configured' },
      },
    ),
  ).toMatchObject({
    cost_usd: null,
    cost_source: SUBSCRIPTION_PRICE_UNAVAILABLE_SOURCE,
  })
})

test('subscription price keys are named for the harness', () => {
  expect(subscriptionMonthlyUsdKey('codex')).toBe('subscription.codex.monthly_usd')
  expect(subscriptionMonthlyUsdKey('grok')).toBe('subscription.grok.monthly_usd')
})
