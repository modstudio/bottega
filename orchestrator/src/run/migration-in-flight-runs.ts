// concern: migration in-flight runs
/** Owns the pre-migration view of runs whose coordinators are still in flight. */

import type { Database } from 'bun:sqlite'
import { isFreshRunHostWait } from './run-host-capacity.ts'

export type MigrationInFlightRun = {
  name: string
  status: 'running' | 'asking'
  waiting: boolean
}

type CompatibleRunRow = {
  id: number | null
  number: number | null
  record_id: string | null
  status: 'running' | 'asking'
  host_wait_since: string | null
}

/** Reads only run columns available at the store's current migration version. */
export function migrationInFlightRuns(
  database: Database,
  now = Date.now(),
): MigrationInFlightRun[] {
  const available = new Set(
    (database.query("SELECT name FROM pragma_table_info('run')").all() as { name: string }[]).map(
      (column) => column.name,
    ),
  )
  const compatibleColumn = (name: 'id' | 'number' | 'record_id' | 'host_wait_since'): string =>
    available.has(name) ? name : `NULL AS ${name}`
  const rows = database
    .query(
      `SELECT ${compatibleColumn('id')}, ${compatibleColumn('number')},
              ${compatibleColumn('record_id')}, status, ${compatibleColumn('host_wait_since')}
       FROM run
       WHERE status IN ('running','asking')`,
    )
    .all() as CompatibleRunRow[]
  return rows
    .map((row) => ({
      name: row.record_id ?? (row.number ? `#${row.number}` : `#${row.id}`),
      status: row.status,
      waiting: isFreshRunHostWait(row.status, row.host_wait_since, now),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}
