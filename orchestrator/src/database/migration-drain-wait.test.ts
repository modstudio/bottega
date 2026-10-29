import { describe, expect, test } from 'bun:test'
import type { MigrationInFlightRun } from '../run/migration-in-flight-runs.ts'
import {
  MIGRATION_DRAIN_REPORT_INTERVAL_MS,
  MIGRATION_DRAIN_TIMEOUT_MS,
  shouldReportMigrationDrain,
  waitForMigrationDrain,
} from './migration-drain-wait.ts'

const waiting: MigrationInFlightRun[] = [
  {
    name: 'run-id',
    status: 'running',
    waiting: false,
    holderPid: 4321,
    kind: 'run-lease',
  },
]

describe('migration drain wait', () => {
  test('expires at the bound and names the migration and waited-on runs', async () => {
    let now = 0
    let sleepCalls = 0
    const lines: string[] = []
    await expect(
      waitForMigrationDrain({
        migration: '0181_fenced',
        presentation: { log: (line) => lines.push(line) },
        startedAt: 0,
        now: () => now,
        sleep: async () => {
          sleepCalls += 1
          if (sleepCalls > 3) throw new Error('deadline loop did not expire')
          now = MIGRATION_DRAIN_TIMEOUT_MS
        },
        inFlight: () => waiting,
      }),
    ).rejects.toThrow(
      'migration 0181_fenced drain expired after 600s; still waiting on run-id (running, holder pid 4321)',
    )
    expect(lines).toEqual([
      'draining for migration 0181_fenced; elapsed 0s, remaining 600s; waiting on run-id (running, holder pid 4321)',
      'draining for migration 0181_fenced; elapsed 600s, remaining 0s; waiting on run-id (running, holder pid 4321)',
    ])
  })

  test('reports at start, on the interval and on a waiting-set change only', () => {
    expect(
      shouldReportMigrationDrain({
        elapsedMs: 0,
        report: 'first',
        lastReport: null,
        lastReportedAtMs: null,
      }),
    ).toBe(true)
    expect(
      shouldReportMigrationDrain({
        elapsedMs: MIGRATION_DRAIN_REPORT_INTERVAL_MS - 1,
        report: 'first',
        lastReport: 'first',
        lastReportedAtMs: 0,
      }),
    ).toBe(false)
    expect(
      shouldReportMigrationDrain({
        elapsedMs: MIGRATION_DRAIN_REPORT_INTERVAL_MS,
        report: 'first',
        lastReport: 'first',
        lastReportedAtMs: 0,
      }),
    ).toBe(true)
    expect(
      shouldReportMigrationDrain({
        elapsedMs: 1,
        report: 'second',
        lastReport: 'first',
        lastReportedAtMs: 0,
      }),
    ).toBe(true)
  })
})
