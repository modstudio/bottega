import { expect, test } from 'bun:test'
import { runUsageMedians } from './route-statistics.ts'

test('run usage medians exclude unknown values instead of treating them as zero', () => {
  expect(
    runUsageMedians([
      { vendorTokens: 900, modelCalls: 3, peakCallTokens: 400 },
      { vendorTokens: null, modelCalls: null, peakCallTokens: null },
    ]),
  ).toEqual({ modelCalls: 3, peakCallTokens: 400, tokensPerRun: 900 })
})
