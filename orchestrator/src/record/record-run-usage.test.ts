import { expect, test } from 'bun:test'
import { OutboxRowError } from './outbox-failure.ts'
import { runUsageRecordValues } from './record-run-usage.ts'

test('run usage refuses a non-finite resource measurement through row validation', () => {
  expect(() => runUsageRecordValues({ resourceCpuMs: Number.POSITIVE_INFINITY })).toThrow(
    OutboxRowError,
  )
})
