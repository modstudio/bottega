import { expect, test } from 'bun:test'
import { loadSubscriptionPrices } from './run-subscription-prices.ts'

test('loadSubscriptionPrices reads user-scope harness monthly prices', async () => {
  const prices = await loadSubscriptionPrices(async () => [
    {
      scope: 'user',
      key: 'subscription.codex.monthly_usd',
      value: '200',
      environment: 'default',
      rowVersion: 1,
      updatedAt: '2026-10-22T00:00:00.000Z',
    },
    {
      scope: 'space',
      key: 'subscription.grok.monthly_usd',
      value: '300',
      environment: 'default',
      rowVersion: 1,
      updatedAt: '2026-10-22T00:00:00.000Z',
    },
    {
      scope: 'user',
      key: 'autonomy.ship-to',
      value: 'production',
      environment: 'default',
      rowVersion: 1,
      updatedAt: '2026-10-22T00:00:00.000Z',
    },
  ])
  expect(prices).toEqual({ codex: 200 })
})
