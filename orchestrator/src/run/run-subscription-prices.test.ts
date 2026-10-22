import { expect, test } from 'bun:test'
import { ConfigClientError } from '../../../shared/config-client.ts'
import {
  loadSubscriptionPrices,
  subscriptionPriceReadWarning,
} from './run-subscription-prices.ts'

test('a 404 price read is unpriced', async () => {
  const loaded = await loadSubscriptionPrices(['codex', 'grok'], async (key) => {
    if (key === 'subscription.codex.monthly_usd') return { value: '200' }
    throw new ConfigClientError('response', `/v1/config/entries/${key}`, 404)
  })
  expect(loaded).toEqual({ prices: { codex: 200, grok: null }, unavailable: {} })
  expect(subscriptionPriceReadWarning(loaded.unavailable)).toBeNull()
})

test('a non-404 price read failure is unavailable rather than unpriced', async () => {
  const error = new ConfigClientError('not-configured', '/v1/config/entries')
  const loaded = await loadSubscriptionPrices(['codex'], async () => {
    throw error
  })
  expect(loaded.prices).toEqual({})
  expect(loaded.unavailable).toEqual({ codex: error.message })
  expect(subscriptionPriceReadWarning(loaded.unavailable)).toBe(
    `refusing to read user-scope subscription.codex.monthly_usd: ${error.message}`,
  )
})
