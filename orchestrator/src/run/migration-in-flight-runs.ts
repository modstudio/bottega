// concern: migration in-flight runs
/** Owns the pre-migration view of runs whose coordinators are still in flight. */

import type { Database } from 'bun:sqlite'
import { isFreshRunHostWait } from './run-host-capacity.ts'
import { heldRunLeaseIds } from './run-lease.ts'

export type MigrationInFlightRun = {
  name: string
  status: string
  waiting: boolean
}

/** Names coordinators that can still touch the store, regardless of their row status. */
export function migrationLeaseHoldingRuns(database: Database): MigrationInFlightRun[] {
  const ids = heldRunLeaseIds()
  if (ids.length === 0) return []
  const available = new Set(
    (database.query("SELECT name FROM pragma_table_info('run')").all() as { name: string }[]).map(
      (column) => column.name,
    ),
  )
  const compatibleColumn = (name: 'id' | 'number' | 'record_id' | 'host_wait_since'): string =>
    available.has(name) ? name : `NULL AS ${name}`
  const rows = database
    .query<
      {
        id: number | null
        record_id: string | null
        number: number | null
        status: string
        host_wait_since: string | null
      },
      []
    >(
      `SELECT ${compatibleColumn('id')}, ${compatibleColumn('record_id')},
              ${compatibleColumn('number')}, status, ${compatibleColumn('host_wait_since')}
         FROM run`,
    )
    .all()
  const byId = new Map(
    rows.flatMap((row) => {
      const identity = row.record_id ?? String(row.number ?? row.id ?? '')
      return identity ? [[identity, row] as const] : []
    }),
  )
  return ids
    .map((id) => {
      const row = byId.get(id)
      return {
        name: row?.record_id ?? (row?.number ? `#${row.number}` : row?.id ? `#${row.id}` : id),
        status: row?.status ?? 'unknown',
        waiting: row ? isFreshRunHostWait(row.status, row.host_wait_since) : false,
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}
