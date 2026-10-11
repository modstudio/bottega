import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../shared/record/schema.ts'
import { db, nowIso, writeTransaction } from './db.ts'
import { decideOutboxLifecycle } from './outbox-lifecycle.ts'
import { projects } from './projects.ts'
import {
  type HostedPushChange,
  type HostedPushOutcome,
  PUSHABLE_HUB_CHANGE_TABLES,
} from './push-contract.ts'
import { hostedPushChanges, hostedTaskIdentity } from './task-client.ts'
import { partitionProjectRows, type RegisteredTaskSpace } from './task-project-space.ts'

const HOSTED_OUTBOX_BATCH_SIZE = 500
const HOSTED_STATUS_EVENT_TABLE = PUSHABLE_HUB_CHANGE_TABLES[0]

type OutboxEntry = {
  id: string
  table_name: string
  row_id: string
  operation: 'upsert' | 'delete'
  queued_at: string
  generation: number
  attempts: number
  last_error: string | null
  quarantined_at: string | null
  quarantine_reason: string | null
}

export type HostedOutboxReport = {
  queued: number
  sent: number
  rejected: number
  quarantined: number
  dropped: number
  waitingOnRouting: Record<string, number>
  skippedCapability: boolean
}

type DrainDependencies = {
  identity?: typeof hostedTaskIdentity
  push?: (
    changes: HostedPushChange[],
    options: { recordSpace: string },
  ) => Promise<HostedPushOutcome[]>
  clock?: () => string
  registered?: () => RegisteredTaskSpace[]
}

type PreparedOutboxRow = {
  entry: OutboxEntry
  project_name: string | null
  change: HostedPushChange
}

export function queueHostedChange(
  conn: Database,
  table: string,
  rowId: string,
  operation: 'upsert' | 'delete',
  queuedAt = nowIso(),
) {
  conn
    .query(
      `INSERT INTO hosted_outbox (id,table_name,row_id,operation,queued_at)
       VALUES (?,?,?,?,?) ON CONFLICT(table_name,row_id) DO UPDATE SET
       operation=excluded.operation,queued_at=excluded.queued_at,
       generation=hosted_outbox.generation+1,attempts=0,last_error=NULL,
       quarantined_at=NULL,quarantine_reason=NULL`,
    )
    .run(newRecordId(), table, rowId, operation, queuedAt)
}

export function listHostedOutbox(): OutboxEntry[] {
  return db()
    .query<OutboxEntry, []>(
      `SELECT * FROM hosted_outbox ORDER BY quarantined_at IS NOT NULL,queued_at,id`,
    )
    .all()
}

export function retryHostedOutboxEntry(id: string): boolean {
  return (
    writeTransaction((conn) =>
      conn
        .query(
          `UPDATE hosted_outbox SET quarantined_at=NULL,quarantine_reason=NULL,last_error=NULL
           WHERE id=? AND quarantined_at IS NOT NULL`,
        )
        .run(id),
    ).changes > 0
  )
}

type CurrentStatusEvent = {
  project_name: string
  id: string
  task_key: string
  task_id: string
  at: string
  from_status: string | null
  to_status: string
  created_at: string
  updated_at: string
  deleted_at: null
}

type LoadedOutboxRow = OutboxEntry & {
  event_id: string | null
  task_key: string | null
  task_record_id: string | null
  event_at: string | null
  from_status: string | null
  to_status: string | null
  project_name: string | null
}

function loadPendingOutboxRows(): LoadedOutboxRow[] {
  return db()
    .query<LoadedOutboxRow, []>(
      `SELECT o.*,e.record_id event_id,e.task_key,e.task_record_id,e.at event_at,
        e.from_status,e.to_status,t.project project_name
       FROM hosted_outbox o
       LEFT JOIN task_status_event e
         ON o.table_name='hub_task_status_event' AND e.record_id=o.row_id
       LEFT JOIN task t ON t.record_id=e.task_record_id
       WHERE o.quarantined_at IS NULL ORDER BY o.queued_at,o.id`,
    )
    .all()
}

function currentStatusEvent(row: LoadedOutboxRow): CurrentStatusEvent | null {
  if (
    !row.event_id ||
    !row.task_key ||
    !row.task_record_id ||
    !row.event_at ||
    !row.to_status ||
    !row.project_name
  )
    return null
  return {
    project_name: row.project_name,
    id: row.event_id,
    task_key: row.task_key,
    task_id: row.task_record_id,
    at: row.event_at,
    from_status: row.from_status,
    to_status: row.to_status,
    created_at: row.event_at,
    updated_at: row.event_at,
    deleted_at: null,
  }
}

function recordOutcome(entry: OutboxEntry, outcome: HostedPushOutcome, at: string) {
  const decision = decideOutboxLifecycle(
    entry.attempts,
    outcome.status === 'rejected'
      ? { kind: 'rejected', reason: outcome.reason }
      : { kind: outcome.status },
  )
  const changed = writeTransaction((conn) => {
    if (decision.action === 'sent') {
      return conn
        .query(`DELETE FROM hosted_outbox WHERE id=? AND generation=?`)
        .run(entry.id, entry.generation).changes
    } else if (decision.action === 'retry') {
      return conn
        .query(
          `UPDATE hosted_outbox SET attempts=?,last_error=?
           WHERE id=? AND generation=? AND quarantined_at IS NULL`,
        )
        .run(decision.attempts, decision.lastError, entry.id, entry.generation).changes
    } else if (decision.action === 'quarantine') {
      return conn
        .query(
          `UPDATE hosted_outbox SET attempts=?,last_error=?,quarantined_at=?,quarantine_reason=?
           WHERE id=? AND generation=? AND quarantined_at IS NULL`,
        )
        .run(decision.attempts, decision.lastError, at, decision.reason, entry.id, entry.generation)
        .changes
    }
    return 0
  })
  return changed > 0 ? decision.action : null
}

function prepareOutboxRows(
  entries: LoadedOutboxRow[],
  report: HostedOutboxReport,
): PreparedOutboxRow[] {
  const rows: PreparedOutboxRow[] = []
  for (const entry of entries) {
    if (entry.operation === 'delete') {
      rows.push({
        entry,
        project_name: null,
        change: { table: HOSTED_STATUS_EVENT_TABLE, id: entry.row_id, op: 'delete' },
      })
      continue
    }
    const row = currentStatusEvent(entry)
    if (!row) {
      const removed = writeTransaction(
        (conn) =>
          conn
            .query(`DELETE FROM hosted_outbox WHERE id=? AND generation=?`)
            .run(entry.id, entry.generation).changes,
      )
      if (removed > 0) report.dropped++
      continue
    }
    rows.push({
      entry,
      project_name: row.project_name,
      change: {
        table: HOSTED_STATUS_EVENT_TABLE,
        id: entry.row_id,
        op: 'upsert',
        row,
      },
    })
  }
  return rows
}

function recordRoutingWaits(
  refusals: Map<string, { reason: string; rows: PreparedOutboxRow[] }>,
  report: HostedOutboxReport,
): void {
  for (const selected of refusals.values())
    report.waitingOnRouting[selected.reason] =
      (report.waitingOnRouting[selected.reason] ?? 0) + selected.rows.length
}

function recordBatchOutcomes(
  batch: PreparedOutboxRow[],
  outcomes: HostedPushOutcome[],
  report: HostedOutboxReport,
  clock: () => string,
): void {
  const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]))
  for (const item of batch) {
    const outcome = byId.get(item.change.id)
    if (!outcome) continue
    const action = recordOutcome(item.entry, outcome, clock())
    if (action === 'sent') report.sent++
    else if (action) {
      report.rejected++
      if (action === 'quarantine') report.quarantined++
    }
  }
}

async function drainDestinations(
  destinations: Map<string, PreparedOutboxRow[]>,
  dependencies: DrainDependencies,
  report: HostedOutboxReport,
): Promise<void> {
  const clock = dependencies.clock ?? nowIso
  for (const [spaceId, selected] of destinations) {
    for (let index = 0; index < selected.length; index += HOSTED_OUTBOX_BATCH_SIZE) {
      const batch = selected.slice(index, index + HOSTED_OUTBOX_BATCH_SIZE)
      try {
        const outcomes = await (dependencies.push ?? hostedPushChanges)(
          batch.map((item) => item.change),
          { recordSpace: spaceId },
        )
        recordBatchOutcomes(batch, outcomes, report, clock)
      } catch {
        break
      }
    }
  }
}

export async function drainHostedOutbox(
  dependencies: DrainDependencies = {},
): Promise<HostedOutboxReport> {
  const entries = loadPendingOutboxRows()
  const report: HostedOutboxReport = {
    queued: entries.length,
    sent: 0,
    rejected: 0,
    quarantined: 0,
    dropped: 0,
    waitingOnRouting: {},
    skippedCapability: false,
  }
  if (!entries.length) return report
  const rows = prepareOutboxRows(entries, report)
  if (!rows.length) return report
  const identity = await (dependencies.identity ?? hostedTaskIdentity)()
  if (identity.capabilities?.spacePush !== true) {
    report.skippedCapability = true
    return report
  }
  const partitioned = partitionProjectRows(rows, (dependencies.registered ?? projects)(), identity)
  recordRoutingWaits(partitioned.refusals, report)
  await drainDestinations(partitioned.destinations, dependencies, report)
  return report
}

export function hostedOutboxLine(report: HostedOutboxReport): string {
  if (report.skippedCapability)
    return `queued=${report.queued} skipped: hosted hub does not advertise spacePush`
  const waiting = Object.entries(report.waitingOnRouting)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(',')
  return (
    `queued=${report.queued} sent=${report.sent} rejected=${report.rejected} ` +
    `quarantined=${report.quarantined} dropped=${report.dropped}` +
    (waiting ? ` waiting-on-routing=${waiting}` : '')
  )
}

export async function hostedOutboxDoctorLines(
  dependencies: Pick<DrainDependencies, 'identity' | 'registered'> = {},
): Promise<string[]> {
  const count = db()
    .query<{ count: number }, []>(
      `SELECT count(*) count FROM hosted_outbox
       WHERE quarantined_at IS NOT NULL`,
    )
    .get()!.count
  const lines = count
    ? [`hosted outbox ${count} quarantined; run \`hub outbox\` and \`hub outbox retry <ID>\``]
    : []
  const rows = loadPendingOutboxRows().flatMap((entry): PreparedOutboxRow[] => {
    if (entry.operation === 'delete')
      return [
        {
          entry,
          project_name: null,
          change: { table: HOSTED_STATUS_EVENT_TABLE, id: entry.row_id, op: 'delete' },
        },
      ]
    const row = currentStatusEvent(entry)
    return row
      ? [
          {
            entry,
            project_name: row.project_name,
            change: {
              table: HOSTED_STATUS_EVENT_TABLE,
              id: entry.row_id,
              op: 'upsert',
              row,
            },
          },
        ]
      : []
  })
  if (!rows.length) return lines
  try {
    const identity = await (dependencies.identity ?? hostedTaskIdentity)()
    const { refusals } = partitionProjectRows(
      rows,
      (dependencies.registered ?? projects)(),
      identity,
    )
    const waiting: Record<string, number> = {}
    for (const refusal of refusals.values())
      waiting[refusal.reason] = (waiting[refusal.reason] ?? 0) + refusal.rows.length
    for (const [reason, waitingCount] of Object.entries(waiting).sort(([a], [b]) =>
      a.localeCompare(b),
    ))
      lines.push(`hosted outbox ${waitingCount} waiting on routing: ${reason}`)
  } catch (error) {
    lines.push(`hosted outbox routing could not be checked: ${(error as Error).message}`)
  }
  return lines
}

export function runHostedOutboxCommand(argv: string[]): string[] {
  if (argv[1] === 'retry') {
    const id = argv[2]
    if (!id) throw new Error('usage: hub outbox retry <ID>')
    if (!retryHostedOutboxEntry(id))
      throw new Error(`outbox entry ${id} is not quarantined and unsent`)
    return [`outbox entry ${id} queued for retry`]
  }
  if (argv[1] && argv[1] !== '--json') throw new Error('usage: hub outbox [--json]')
  const rows = listHostedOutbox()
  if (argv.includes('--json')) return [JSON.stringify(rows)]
  if (!rows.length) return ['hosted outbox is empty']
  return rows.map(
    (row) =>
      `${row.id} ${row.table_name} ${row.row_id} ${row.operation} attempts=${row.attempts} ` +
      `${row.quarantined_at ? `quarantined=${row.quarantine_reason}` : `queued=${row.queued_at}`}`,
  )
}
