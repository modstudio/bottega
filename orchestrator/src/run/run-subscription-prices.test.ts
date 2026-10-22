import { expect, test } from 'bun:test'
import { ConfigClientError } from '../../../shared/config-client.ts'
import { loadSubscriptionPrices } from './run-subscription-prices.ts'

test('loadSubscriptionPrices reads the caller user-scope harness monthly prices', async () => {
  const prices = await loadSubscriptionPrices(['codex', 'grok'], async (key) => {
    if (key === 'subscription.codex.monthly_usd') return { value: '200' }
    throw new ConfigClientError('response', `/v1/config/entries/${key}`, 404)
  })
  expect(prices).toEqual({ codex: 200, grok: null })
})

test('a price read failure refuses rather than reporting unpriced', async () => {
  await expect(
    loadSubscriptionPrices(['codex'], async () => {
      throw new Error('hosted config route /v1/config/entries is unreachable')
    }),
  ).rejects.toThrow(
    'refusing to read user-scope subscription.codex.monthly_usd: hosted config route /v1/config/entries is unreachable',
  )
})
