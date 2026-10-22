import { expect, test } from 'bun:test'
import { SUBSCRIPTION_STORED_SOURCE } from './run-subscription-cost.ts'
import { runUsageColumns } from './run-usage-columns.ts'

test('a subscription agent stores billing kind and no list-price estimate', () => {
  expect(
    runUsageColumns(
      {
        inputTokens: 12,
        outputTokens: 22,
        estimatedCostUsd: 0.45,
        costSource: 'estimated',
      },
      'subscription',
    ),
  ).toEqual({
    vendorInputTokens: 12,
    vendorOutputTokens: 22,
    vendorEstimatedCostUsd: null,
    vendorCostSource: SUBSCRIPTION_STORED_SOURCE,
  })
})

test('a metered agent keeps billed usage columns', () => {
  expect(
    runUsageColumns(
      {
        inputTokens: 10,
        outputTokens: 5,
        estimatedCostUsd: null,
        costSource: 'billed',
      },
      'metered',
    ),
  ).toEqual({
    vendorInputTokens: 10,
    vendorOutputTokens: 5,
    vendorEstimatedCostUsd: null,
    vendorCostSource: 'billed',
  })
})
