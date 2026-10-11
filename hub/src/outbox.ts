import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../shared/record/schema.ts'
import { db, nowIso, writeTransaction } from './db.ts'
import { decideOutboxLifecycle } from './outbox-lifecycle.ts'
import { loadOutboxChange } from './outbox-row.ts'
import { projects } from './projects.ts'
import {
  HOSTED_INTERVAL_TABLE,
  HOSTED_STATUS_EVENT_TABLE,
  HOSTED_TASK_TABLE,
  type HostedPushChange,
  type HostedPushOutcome,
} from './push-contract.ts'
import { orderHostedPushChanges } from './push-order.ts'
import { persistTaskAdoptionsOn } from './task-adoption.ts'
import { hostedPushChanges, hostedTaskIdentity } from './task-client.ts'
import { partitionProjectRows, type RegisteredTaskSpace } from './task-project-space.ts'

const HOSTED_OUTBOX_BATCH_SIZE = 500

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
  routing_space_id: string | null
  routing_project: string | null
}

export type HostedOutboxReport = {
  queued: number
  sent: number
  rejected: number
  quarantined: number
  dropped: number
  waitingOnRouting: Record<string, number>
  waitingOnHostedHub?: Record<string, number>
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
  acknowledgedSpaceId: string | null
  destinationSpaceId: string | null
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

function loadPendingOutboxRows(): OutboxEntry[] {
  return db()
    .query<OutboxEntry, []>(
      `SELECT * FROM hosted_outbox
       WHERE quarantined_at IS NULL ORDER BY queued_at,id`,
    )
    .all()
}

function recordOutcome(item: PreparedOutboxRow, outcome: HostedPushOutcome, at: string) {
  const { entry } = item
  const decision = decideOutboxLifecycle(
    entry.attempts,
    outcome.status === 'rejected'
      ? { kind: 'rejected', reason: outcome.reason }
      : { kind: outcome.status },
  )
  const changed = writeTransaction((conn) => {
    if (decision.action === 'sent') {
      if (
        item.change.table === HOSTED_INTERVAL_TABLE &&
        item.change.op === 'upsert' &&
        outcome.status !== 'rejected'
      )
        conn
          .query(`UPDATE interval SET hosted_space_id=? WHERE record_id=?`)
          .run(item.destinationSpaceId, item.change.id)
      const removed = conn
        .query(`DELETE FROM hosted_outbox WHERE id=? AND generation=?`)
        .run(entry.id, entry.generation).changes
      if (
        removed > 0 &&
        outcome.status !== 'rejected' &&
        outcome.adoptedId &&
        item.change.table === HOSTED_TASK_TABLE &&
        item.change.op === 'upsert'
      )
        persistTaskAdoptionsOn(conn, [
          {
            table: 'task',
            project: item.change.row.project,
            key: item.change.row.key,
            id: outcome.adoptedId,
          },
        ])
      return removed
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

function prepareOutboxRows(entries: OutboxEntry[]): {
  rows: PreparedOutboxRow[]
  missing: OutboxEntry[]
} {
  const rows: PreparedOutboxRow[] = []
  const missing: OutboxEntry[] = []
  for (const entry of entries) {
    const loaded = loadOutboxChange(db(), entry)
    if (!loaded) {
      missing.push(entry)
      continue
    }
    rows.push({
      entry,
      project_name: loaded.projectName,
      change: loaded.change,
      acknowledgedSpaceId: loaded.acknowledgedSpaceId ?? null,
      destinationSpaceId: null,
    })
  }
  return { rows, missing }
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
    const action = recordOutcome(item, outcome, clock())
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
): Promise<boolean> {
  const clock = dependencies.clock ?? nowIso
  for (const intervalDeletes of [true, false]) {
    for (const [spaceId, selected] of destinations) {
      for (const item of selected) item.destinationSpaceId = spaceId
      const phase = selected.filter(
        (item) =>
          (item.change.table === HOSTED_INTERVAL_TABLE && item.change.op === 'delete') ===
          intervalDeletes,
      )
      const byId = new Map(phase.map((item) => [item.change.id, item]))
      const ordered = orderHostedPushChanges(phase.map((item) => item.change)).map(
        (change) => byId.get(change.id)!,
      )
      for (let index = 0; index < ordered.length; index += HOSTED_OUTBOX_BATCH_SIZE) {
        const batch = ordered.slice(index, index + HOSTED_OUTBOX_BATCH_SIZE)
        try {
          const outcomes = await (dependencies.push ?? hostedPushChanges)(
            batch.map((item) => item.change),
            { recordSpace: spaceId },
          )
          recordBatchOutcomes(batch, outcomes, report, clock)
        } catch {
          return false
        }
      }
    }
  }
  return true
}

async function removeMovedIntervals(
  destinations: Map<string, PreparedOutboxRow[]>,
  dependencies: DrainDependencies,
  report: HostedOutboxReport,
): Promise<boolean> {
  const push = dependencies.push ?? hostedPushChanges
  const clock = dependencies.clock ?? nowIso
  const blocked = new Set<PreparedOutboxRow>()
  for (const [destination, rows] of destinations) {
    for (const item of rows) {
      const result = await removeMovedInterval(item, destination, push, clock, report)
      if (result === 'failed') return false
      if (result === 'blocked') blocked.add(item)
    }
    destinations.set(
      destination,
      rows.filter((row) => !blocked.has(row)),
    )
  }
  return true
}

async function removeMovedInterval(
  item: PreparedOutboxRow,
  destination: string,
  push: NonNullable<DrainDependencies['push']>,
  clock: () => string,
  report: HostedOutboxReport,
): Promise<'ready' | 'blocked' | 'failed'> {
  if (
    item.change.table !== HOSTED_INTERVAL_TABLE ||
    item.change.op !== 'upsert' ||
    !item.acknowledgedSpaceId ||
    item.acknowledgedSpaceId === destination
  )
    return 'ready'
  let outcomes: HostedPushOutcome[]
  try {
    outcomes = await push([{ table: HOSTED_INTERVAL_TABLE, id: item.change.id, op: 'delete' }], {
      recordSpace: item.acknowledgedSpaceId,
    })
  } catch {
    return 'failed'
  }
  const outcome = outcomes[0]
  if (!outcome) return 'failed'
  if (outcome.status === 'applied' || outcome.status === 'duplicate') {
    writeTransaction((conn) =>
      conn
        .query(`UPDATE interval SET hosted_space_id=NULL WHERE record_id=? AND hosted_space_id=?`)
        .run(item.change.id, item.acknowledgedSpaceId),
    )
    item.acknowledgedSpaceId = null
    return 'ready'
  }
  const action = recordOutcome(item, outcome, clock())
  if (action) report.rejected++
  if (action === 'quarantine') report.quarantined++
  return 'blocked'
}

function routeOutboxRows(
  rows: PreparedOutboxRow[],
  registered: RegisteredTaskSpace[],
  identity: Awaited<ReturnType<typeof hostedTaskIdentity>>,
) {
  const fixed = rows.filter(
    (row) =>
      row.change.table === HOSTED_INTERVAL_TABLE &&
      row.change.op === 'delete' &&
      row.acknowledgedSpaceId,
  )
  const routed = partitionProjectRows(
    rows.filter((row) => !fixed.includes(row)),
    registered,
    identity,
  )
  for (const row of fixed) {
    const selected = routed.destinations.get(row.acknowledgedSpaceId!) ?? []
    selected.push(row)
    routed.destinations.set(row.acknowledgedSpaceId!, selected)
  }
  return routed
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
    waitingOnHostedHub: {},
    skippedCapability: false,
  }
  if (!entries.length) return report
  const prepared = prepareOutboxRows(entries)
  for (const entry of prepared.missing) {
    const removed = writeTransaction(
      (conn) =>
        conn
          .query(`DELETE FROM hosted_outbox WHERE id=? AND generation=?`)
          .run(entry.id, entry.generation).changes,
    )
    if (removed > 0) report.dropped++
  }
  let rows = prepared.rows
  if (!rows.length) return report
  const identity = await (dependencies.identity ?? hostedTaskIdentity)()
  if (identity.capabilities?.spacePush !== true) {
    report.skippedCapability = true
    return report
  }
  const accepted = new Set(
    identity.capabilities.spacePushTables ?? [HOSTED_TASK_TABLE, HOSTED_STATUS_EVENT_TABLE],
  )
  const waiting = rows.filter((row) => !accepted.has(row.change.table))
  for (const row of waiting)
    report.waitingOnHostedHub![row.change.table] =
      (report.waitingOnHostedHub![row.change.table] ?? 0) + 1
  rows = rows.filter((row) => accepted.has(row.change.table))
  if (!rows.length) return report
  const partitioned = routeOutboxRows(rows, (dependencies.registered ?? projects)(), identity)
  recordRoutingWaits(partitioned.refusals, report)
  if (await removeMovedIntervals(partitioned.destinations, dependencies, report))
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
  const hostedWaiting = Object.entries(report.waitingOnHostedHub ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([table, count]) => `${table}=${count}`)
    .join(',')
  return (
    `queued=${report.queued} sent=${report.sent} rejected=${report.rejected} ` +
    `quarantined=${report.quarantined} dropped=${report.dropped}` +
    (waiting ? ` waiting-on-routing=${waiting}` : '') +
    (hostedWaiting ? ` waiting-on-hosted-hub=${hostedWaiting}` : '')
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
  let rows = prepareOutboxRows(loadPendingOutboxRows()).rows
  if (!rows.length) return lines
  try {
    const identity = await (dependencies.identity ?? hostedTaskIdentity)()
    const accepted = new Set(
      identity.capabilities?.spacePushTables ?? [HOSTED_TASK_TABLE, HOSTED_STATUS_EVENT_TABLE],
    )
    const waitingOnHub = rows.filter((row) => !accepted.has(row.change.table))
    const byTable = new Map<string, number>()
    for (const row of waitingOnHub)
      byTable.set(row.change.table, (byTable.get(row.change.table) ?? 0) + 1)
    for (const [table, waitingCount] of [...byTable].sort(([a], [b]) => a.localeCompare(b)))
      lines.push(`hosted outbox ${waitingCount} waiting on hosted hub: ${table}`)
    rows = rows.filter((row) => accepted.has(row.change.table))
    const { refusals } = routeOutboxRows(rows, (dependencies.registered ?? projects)(), identity)
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
