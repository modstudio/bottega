import { expect, test } from 'bun:test'
import type { HealthRunRow } from './health.ts'
import { wastedTimeReport } from './wasted-time-report.ts'

const row = (failureKind: HealthRunRow['failure_kind'], status = 'failed'): HealthRunRow => ({
  record_id: String(failureKind),
  number: 1,
  started_at: '2026-10-01T01:00:00Z',
  latency_ms: 1_000,
  failure_kind: failureKind,
  status,
  error: null,
  work_preserved: 0,
})

test('wasted time uses machine-health failure classification', () => {
  const report = wastedTimeReport(
    [
      row('timeout'),
      row('quota'),
      row('auth'),
      row('capacity'),
      row(null, 'stopped'),
      row('other'),
    ],
    { start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z' },
  )
  expect(report.classes.map(({ kind, count }) => ({ kind, count }))).toEqual([
    { kind: 'timeout', count: 1 },
    { kind: 'quota', count: 1 },
    { kind: 'auth', count: 1 },
    { kind: 'capacity', count: 1 },
    { kind: 'stopped', count: 1 },
  ])
})
