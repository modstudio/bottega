import { expect, test } from 'bun:test'
import { OutboxRowError } from './outbox-failure.ts'
import { runUsageRecordValues } from './record-run-usage.ts'

test('run usage refuses a non-numeric resource measurement through row validation', () => {
  expect(() => runUsageRecordValues({ resourceCpuMs: 'not-a-number' })).toThrow(OutboxRowError)
})

test('run usage keeps per-call facts nullable and validates the count', () => {
  expect(runUsageRecordValues({ modelCalls: null, peakCallTokens: null })).toMatchObject({
    modelCalls: null,
    peakCallTokens: null,
  })
  expect(() => runUsageRecordValues({ modelCalls: 1.5 })).toThrow(OutboxRowError)
})
