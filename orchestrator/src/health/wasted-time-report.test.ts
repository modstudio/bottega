import { expect, test } from 'bun:test'
import type { HealthRunRow } from './health.ts'
import { wastedTimeReport } from './wasted-time-report.ts'

const row = (
  failureKind: HealthRunRow['failure_kind'],
  status = 'failed',
  latencyMs = 1_000,
): HealthRunRow => ({
  record_id: String(failureKind),
  number: 1,
  started_at: '2026-10-01T01:00:00Z',
  latency_ms: latencyMs,
  failure_kind: failureKind,
  status,
  error: null,
  work_preserved: 0,
})

test('wasted time uses machine-health failure classification', () => {
  const report = wastedTimeReport(
    [
      row('timeout', 'failed', 2_000),
      row('quota', 'failed', -1),
      row('auth'),
      row('capacity'),
      row(null, 'stopped'),
      row('other'),
    ],
    { start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z' },
  )
  expect(report.classes.find((entry) => entry.kind === 'timeout')).toEqual({
    kind: 'timeout',
    count: 1,
    totalTimeMs: 2_000,
  })
  expect(report.classes.find((entry) => entry.kind === 'quota')).toEqual({
    kind: 'quota',
    count: 1,
    totalTimeMs: 0,
  })
  expect(report.classes.find((entry) => entry.kind === 'other')).toEqual({
    kind: 'other',
    count: 1,
    totalTimeMs: 1_000,
  })
  expect(report.classes.find((entry) => entry.kind === 'stale')).toEqual({
    kind: 'stale',
    count: 0,
    totalTimeMs: 0,
  })
})
