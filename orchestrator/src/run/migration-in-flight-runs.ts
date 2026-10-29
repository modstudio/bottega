// concern: migration in-flight runs
/** Owns the pre-migration view of runs whose coordinators are still in flight. */

import type { Database } from 'bun:sqlite'
import {
  type PidRecordIdentity,
  pidAlive,
  pidRecordIdentity,
} from '../../../shared/process-identity.ts'
import { isFreshRunHostWait } from './run-host-capacity.ts'
import { heldRunCloseOutLeaseIds, heldRunLeaseIds } from './run-lease.ts'

export type MigrationInFlightRun = {
  name: string
  status: string
  waiting: boolean
  holderPid: number | null
  kind: 'run-lease' | 'close-out' | 'row'
}

export function formatMigrationInFlightRun(run: MigrationInFlightRun): string {
  const holder = `, holder pid ${run.holderPid ?? 'unknown'}`
  const closing = run.kind === 'close-out' ? ', closing' : ''
  return `${run.name} (${run.status}${holder}${closing})`
}

/** Names coordinators that can still touch the store, regardless of their row status. */
function migrationHeldRuns(
  database: Database,
  ids: string[],
  kind: 'run' | 'close-out',
): MigrationInFlightRun[] {
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
        kind: kind === 'run' ? ('run-lease' as const) : ('close-out' as const),
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function migrationLeaseHoldingRuns(database: Database): MigrationInFlightRun[] {
  return migrationHeldRuns(database, heldRunLeaseIds(), 'run')
}

function migrationCloseOutHoldingRuns(database: Database): MigrationInFlightRun[] {
  return migrationHeldRuns(database, heldRunCloseOutLeaseIds(), 'close-out')
}

export function askingRowMayHoldOldSchema(input: {
  hasLease: boolean
  coordinatorAlive: boolean
  agentIdentity: PidRecordIdentity
}): boolean {
  return (
    input.hasLease ||
    input.coordinatorAlive ||
    input.agentIdentity === 'live' ||
    input.agentIdentity === 'unknown'
  )
}

/**
 * Answers "may a live process still hold a handle the migration would invalidate?".
 * An asking row is excluded only when neither coordinator nor agent may still be alive.
 */
export function migrationInFlightRuns(database: Database): MigrationInFlightRun[] {
  const closing = migrationCloseOutHoldingRuns(database)
  const holding = migrationLeaseHoldingRuns(database)
  const byName = new Map(closing.map((run) => [run.name, run]))
  for (const run of holding) byName.set(run.name, run)
  const rows = database
    .query<
      {
        id?: number | null
        number?: number | null
        record_id?: string | null
        status: string
        pid?: number | null
        agent_pid?: number | null
        agent_start_time?: string | null
        host_wait_since?: string | null
      },
      []
    >("SELECT * FROM run WHERE status IN ('reserved','attached','running','asking')")
    .all()
  for (const row of rows) {
    const name = row.record_id ?? (row.number ? `#${row.number}` : `#${row.id}`)
    const existing = byName.get(name)
    let askingHolderPid: number | null = null
    if (row.status === 'asking') {
      const coordinatorAlive = pidAlive(row.pid ?? null)
      const agentIdentity = pidRecordIdentity(row.agent_pid, row.agent_start_time)
      if (
        !askingRowMayHoldOldSchema({
          hasLease: existing !== undefined,
          coordinatorAlive,
          agentIdentity,
        })
      ) {
        continue
      }
      askingHolderPid = coordinatorAlive ? (row.pid ?? null) : (row.agent_pid ?? null)
    }
    byName.set(name, {
      name,
      status: row.status,
      waiting: isFreshRunHostWait(row.status, row.host_wait_since),
      holderPid:
        row.status === 'asking' ? askingHolderPid : (existing?.holderPid ?? row.pid ?? null),
      kind: existing?.kind ?? 'row',
    })
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))
}
