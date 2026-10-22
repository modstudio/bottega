import { expect, test } from 'bun:test'
import { usageForBilling, type VendorUsage } from './vendor-usage.ts'

const usage = (overrides: Partial<VendorUsage>): VendorUsage => ({
  inputTokens: 100,
  outputTokens: 20,
  estimatedCostUsd: null,
  costSource: null,
  ...overrides,
})

test('subscription usage keeps tokens but records no vendor USD', () => {
  expect(
    usageForBilling('subscription', {
      costUsd: 1.25,
      vendorUsage: usage({ costSource: 'billed' }),
    }),
  ).toEqual({
    costUsd: null,
    vendorUsage: usage({ costSource: 'none' }),
  })
})

test('metered usage keeps provider-reported billed cost', () => {
  const observed = {
    costUsd: 1.25,
    vendorUsage: usage({ costSource: 'billed' as const }),
  }
  expect(usageForBilling('metered', observed)).toEqual(observed)
})

test('metered usage keeps a vendor estimate when no billed cost was reported', () => {
  const observed = {
    costUsd: null,
    vendorUsage: usage({ estimatedCostUsd: 1.25, costSource: 'estimated' as const }),
  }
  expect(usageForBilling('metered', observed)).toEqual(observed)
})
