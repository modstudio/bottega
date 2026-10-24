// concern: migration in-flight runs
/** Owns the pre-migration view of runs whose coordinators are still in flight. */

import type { Database } from 'bun:sqlite'
import { isFreshRunHostWait } from './run-host-capacity.ts'
import { heldRunLeaseIds } from './run-lease.ts'

export type MigrationInFlightRun = {
  name: string
  status: string
  waiting: boolean
  holderPid: number | null
  leaseHolding: boolean
}

export function formatMigrationInFlightRun(run: MigrationInFlightRun): string {
  const holder = run.leaseHolding
    ? `, holder pid ${run.holderPid ?? 'unknown'}`
    : run.holderPid
      ? `, coordinator pid ${run.holderPid}`
      : ''
  return `${run.name} (${run.status}${holder})`
}

/** Names coordinators that can still touch the store, regardless of their row status. */
export function migrationLeaseHoldingRuns(database: Database): MigrationInFlightRun[] {
  const ids = heldRunLeaseIds()
  const available = new Set(
    (database.query("SELECT name FROM pragma_table_info('run')").all() as { name: string }[]).map(
      (column) => column.name,
    ),
  )
  const compatibleColumn = (
    name: 'id' | 'number' | 'record_id' | 'host_wait_since' | 'pid',
  ): string => (available.has(name) ? name : `NULL AS ${name}`)
  const rows = database
    .query<
      {
        id: number | null
        record_id: string | null
        number: number | null
        status: string
        host_wait_since: string | null
        pid: number | null
      },
      []
    >(
      `SELECT ${compatibleColumn('id')}, ${compatibleColumn('record_id')},
              ${compatibleColumn('number')}, status, ${compatibleColumn('host_wait_since')},
              ${compatibleColumn('pid')}
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
        holderPid: row?.pid ?? null,
        leaseHolding: true,
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** Runs that can still acquire or currently hold an old-schema coordinator lease. */
export function migrationInFlightRuns(database: Database): MigrationInFlightRun[] {
  const holding = migrationLeaseHoldingRuns(database)
  const byName = new Map(holding.map((run) => [run.name, run]))
  const rows = database
    .query<
      {
        id?: number | null
        number?: number | null
        record_id?: string | null
        status: string
        pid?: number | null
        host_wait_since?: string | null
      },
      []
    >("SELECT * FROM run WHERE status IN ('reserved','attached','running','asking')")
    .all()
  for (const row of rows) {
    const name = row.record_id ?? (row.number ? `#${row.number}` : `#${row.id}`)
    const existing = byName.get(name)
    byName.set(name, {
      name,
      status: row.status,
      waiting: isFreshRunHostWait(row.status, row.host_wait_since),
      holderPid: existing?.holderPid ?? row.pid ?? null,
      leaseHolding: existing?.leaseHolding ?? false,
    })
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))
}
