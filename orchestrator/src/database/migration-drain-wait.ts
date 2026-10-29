// concern: bounded migration drain wait
/** Owns the deadline and reporting policy for waiting on old-schema processes. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  formatMigrationInFlightRun,
  type MigrationInFlightRun,
} from '../run/migration-in-flight-runs.ts'

export const MIGRATION_DRAIN_TIMEOUT_MS = 10 * 60_000
export const MIGRATION_DRAIN_REPORT_INTERVAL_MS = 30_000
const MIGRATION_DRAIN_POLL_MS = 1_000

export function shouldReportMigrationDrain(input: {
  elapsedMs: number
  report: string
  lastReport: string | null
  lastReportedAtMs: number | null
}): boolean {
  return (
    input.lastReport === null ||
    input.report !== input.lastReport ||
    input.lastReportedAtMs === null ||
    input.elapsedMs - input.lastReportedAtMs >= MIGRATION_DRAIN_REPORT_INTERVAL_MS
  )
}

function seconds(milliseconds: number): string {
  return `${Math.ceil(milliseconds / 1_000)}s`
}

export async function waitForMigrationDrain(input: {
  migration: string
  presentation: { log(value: string): void }
  startedAt: number
  now: () => number
  sleep: (ms: number) => Promise<unknown>
  inFlight: () => MigrationInFlightRun[]
}): Promise<void> {
  let lastReport: string | null = null
  let lastReportedAtMs: number | null = null
  for (;;) {
    const runs = input.inFlight()
    if (runs.length === 0) return
    const now = input.now()
    const elapsedMs = Math.max(0, now - input.startedAt)
    const remainingMs = Math.max(0, MIGRATION_DRAIN_TIMEOUT_MS - elapsedMs)
    const report = runs.map(formatMigrationInFlightRun).join(', ')
    if (shouldReportMigrationDrain({ elapsedMs, report, lastReport, lastReportedAtMs })) {
      input.presentation.log(
        `draining for migration ${input.migration}; elapsed ${seconds(elapsedMs)}, remaining ${seconds(remainingMs)}; waiting on ${report}`,
      )
      lastReport = report
      lastReportedAtMs = elapsedMs
    }
    if (elapsedMs >= MIGRATION_DRAIN_TIMEOUT_MS) {
      throw new Error(
        `migration ${input.migration} drain expired after ${seconds(elapsedMs)}; still waiting on ${report}; ` +
          `re-run ${PLATFORM_SLUG} machine update when those runs finish, or run ${PLATFORM_SLUG} machine migrate ` +
          `--force-in-flight "<reason>" --from-operator`,
      )
    }
    await input.sleep(MIGRATION_DRAIN_POLL_MS)
  }
}
