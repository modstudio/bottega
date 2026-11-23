// concern: read-only run confinement measurement; owns the local run query and window.

import type { Database } from 'bun:sqlite'
import { isReadOnlyRepositoryJob, JOBS } from '../jobs/jobs.ts'
import { parseRunListSince } from './run-listing-since.ts'
import { CONFINEMENT_RUN_WINDOW_DAYS } from './run-confinement-constants.ts'

export { CONFINEMENT_RUN_WINDOW_DAYS } from './run-confinement-constants.ts'
const CONFINEMENT_RUN_WINDOW_MS = CONFINEMENT_RUN_WINDOW_DAYS * 24 * 60 * 60 * 1000
const UNRECORDED_SANDBOX_VALUE = 'unrecorded'

type RunConfinementCount = {
  sandbox: string
  reason: string
  count: number
}

export type RunConfinementCounts = {
  since: string
  defaultWindow: boolean
  rows: RunConfinementCount[]
}

function runConfinementWindow(
  since: string | undefined,
  now: number,
): Pick<RunConfinementCounts, 'since' | 'defaultWindow'> {
  const parsed = parseRunListSince(since)
  return parsed === undefined
    ? { since: new Date(now - CONFINEMENT_RUN_WINDOW_MS).toISOString(), defaultWindow: true }
    : { since: parsed, defaultWindow: false }
}

/** Count repository-reading, non-writing run rows by their recorded sandbox decision. */
export function countRunConfinement(
  database: Database,
  since: string | undefined,
  now = Date.now(),
): RunConfinementCounts {
  const window = runConfinementWindow(since, now)
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
