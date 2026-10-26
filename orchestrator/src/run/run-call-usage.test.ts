import { expect, test } from 'bun:test'
import { foldRunCallUsage } from './run-call-usage.ts'

test('folds streamed usage into a call count and peak without inventing an unknown zero', () => {
  let summary = foldRunCallUsage(null, { kind: 'text', text: 'working' })
  expect(summary).toBeNull()
  summary = foldRunCallUsage(summary, {
    kind: 'usage',
    tokens: 1_000,
    costUsd: null,
    per: 'turn',
  })
  expect(summary).toBeNull()
  summary = foldRunCallUsage(summary, { kind: 'usage', tokens: 120, costUsd: null, per: 'call' })
  summary = foldRunCallUsage(summary, { kind: 'usage', tokens: 340, costUsd: null, per: 'call' })
  summary = foldRunCallUsage(summary, { kind: 'usage', tokens: 220, costUsd: null, per: 'call' })
  expect(summary).toEqual({ modelCalls: 3, peakCallTokens: 340 })
})
