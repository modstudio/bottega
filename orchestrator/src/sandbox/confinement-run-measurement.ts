// concern: read-only run confinement measurement; owns the local run query, not profile policy.

import type { Database } from 'bun:sqlite'
import { isReadOnlyRepositoryJob, JOBS } from '../jobs/jobs.ts'
import { parseRunListSince } from '../run/run-listing.ts'

export const CONFINEMENT_RUN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const UNRECORDED_SANDBOX_VALUE = 'unrecorded'

type ConfinementRunCount = {
  sandbox: string
  reason: string
  count: number
}

export type ConfinementRunMeasurement = {
  since: string
  defaultWindow: boolean
  rows: ConfinementRunCount[]
}

/** Resolve the explicit run-list-compatible cutoff or the named seven-day default. */
export function confinementRunWindow(
  since: string | undefined,
  now = Date.now(),
): Pick<ConfinementRunMeasurement, 'since' | 'defaultWindow'> {
  const parsed = parseRunListSince(since)
  return parsed === undefined
    ? { since: new Date(now - CONFINEMENT_RUN_WINDOW_MS).toISOString(), defaultWindow: true }
    : { since: parsed, defaultWindow: false }
}

/** Count repository-reading, non-writing run rows by their recorded sandbox decision. */
export function measureConfinementRuns(
  database: Database,
  since: string | undefined,
  now = Date.now(),
): ConfinementRunMeasurement {
  const window = confinementRunWindow(since, now)
  const jobs = Object.keys(JOBS).filter(isReadOnlyRepositoryJob)
  const marks = jobs.map(() => '?').join(',')
  const rows = database
    .query<{ sandbox: string | null; reason: string | null; count: number }, Array<string>>(
      `SELECT sandbox, sandbox_reason AS reason, COUNT(*) AS count
         FROM run
        WHERE started_at >= ? AND job IN (${marks})
        GROUP BY sandbox, sandbox_reason
        ORDER BY sandbox, sandbox_reason`,
    )
    .all(window.since, ...jobs)
    .map((row) => ({
      sandbox: row.sandbox ?? UNRECORDED_SANDBOX_VALUE,
      reason: row.reason ?? UNRECORDED_SANDBOX_VALUE,
      count: row.count,
    }))
  return { ...window, rows }
}

export function formatConfinementRunMeasurement(measurement: ConfinementRunMeasurement): string[] {
  const defaultLabel = measurement.defaultWindow ? ' (default seven days)' : ''
  return [
    `read-only-run-window  since=${measurement.since}${defaultLabel}`,
    ...measurement.rows.map(
      (row) =>
        `read-only-run-count  sandbox=${row.sandbox}  reason=${JSON.stringify(row.reason)}  count=${row.count}`,
    ),
  ]
}
