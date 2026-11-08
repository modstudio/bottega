import { expect, test } from 'bun:test'
import { routingEvidenceWindow, runUsageMedians } from './route-statistics.ts'

test('run usage medians exclude unknown values instead of treating them as zero', () => {
  expect(
    runUsageMedians([
      { vendorTokens: 900, modelCalls: 3, peakCallTokens: 400 },
      { vendorTokens: null, modelCalls: null, peakCallTokens: null },
    ]),
  ).toEqual({ modelCalls: 3, peakCallTokens: 400, tokensPerRun: 900 })
})

test('routing evidence window treats only OpenRouter routing variants as the current model', () => {
  const rows = [
    {
      record_id: 'run-base',
      agent: 'deepseek',
      model: 'deepseek/deepseek-v4.1-flash',
      startedAt: '2026-11-08T12:00:00.000Z',
    },
  ]
  const currentModel = 'deepseek/deepseek-v4.1-flash:floor'

  expect(
    routingEvidenceWindow(rows, 'deepseek', currentModel, 'https://openrouter.ai/api/v1', 10),
  ).toEqual({ rows, evidenceModel: 'deepseek/deepseek-v4.1-flash' })
  expect(
    routingEvidenceWindow(rows, 'deepseek', currentModel, 'https://models.example.test/v1', 10),
  ).toEqual({ rows: [], evidenceModel: currentModel })
})
