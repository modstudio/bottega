import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { newRecordId } from '../../shared/record/schema.ts'
import { db, nowIso, writeTransaction } from './db.ts'
import type { PendingHostedOutbox } from './outbox-fast-cycle.ts'
import { decideOutboxLifecycle } from './outbox-lifecycle.ts'
import { loadOutboxChange } from './outbox-row.ts'
import { type OutboxProcessKind, recordOutboxTrace } from './outbox-trace.ts'
import { projects } from './projects.ts'
import {
  HOSTED_COMMENT_TABLE,
  HOSTED_DOCUMENT_TABLE,
  HOSTED_INTERVAL_TABLE,
  HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE,
  HOSTED_STATUS_EVENT_TABLE,
  HOSTED_TASK_TABLE,
  type HostedPushChange,
  type HostedPushOutcome,
} from './push-contract.ts'
import { orderHostedPushChanges } from './push-order.ts'
import { acquireStoredLease, holdStoredLease, StoredLeaseLostError } from './store-lease.ts'
import { persistTaskAdoptionsOn } from './task-adoption.ts'
import { hostedPushChanges, hostedTaskIdentity } from './task-client.ts'
import { partitionProjectRows, type RegisteredTaskSpace } from './task-project-space.ts'

const HOSTED_OUTBOX_BATCH_SIZE = 500
const HOSTED_OUTBOX_LEASE_MS = 60_000
const HOSTED_OUTBOX_LEASE_RENEW_MS = 20_000
const HOSTED_OUTBOX_LEASE_KEY = 'hosted-outbox.lease'

export type OutboxEntry = {
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
  routing_project_record_id: string | null
  fields: string | null
  kept_values: string | null
}

export function mergeQueuedHostedChange(
  prior: {
    operation: 'upsert' | 'delete'
    fields: readonly string[] | null
  } | null,
  incoming: {
    operation: 'upsert' | 'delete'
    fields: readonly string[] | null
  },
): { operation: 'upsert' | 'delete'; fields: string[] | null } {
  if (incoming.operation === 'delete') return { operation: 'delete', fields: null }
  if (!prior || prior.operation === 'delete')
    return {
      operation: 'upsert',
      fields: incoming.fields ? [...new Set(incoming.fields)] : null,
    }
  if (prior.fields === null || incoming.fields === null)
    return { operation: 'upsert', fields: null }
  return {
    operation: 'upsert',
    fields: [...new Set([...prior.fields, ...incoming.fields])],
  }
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
  hostedReachable?: boolean
  lockAcquired?: boolean
}

type DrainDependencies = {
  identity?: typeof hostedTaskIdentity
  push?: (
    changes: HostedPushChange[],
    options: { recordSpace: string },
  ) => Promise<HostedPushOutcome[]>
  clock?: () => string
  registered?: () => RegisteredTaskSpace[]
  processKind?: OutboxProcessKind
  assertLock?: () => void
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
  fields: readonly string[] | null = null,
) {
  const prior = conn
    .query<{ operation: 'upsert' | 'delete'; fields: string | null }, [string, string]>(
      `SELECT operation,fields FROM hosted_outbox WHERE table_name=? AND row_id=?`,
    )
    .get(table, rowId)
  const merged = mergeQueuedHostedChange(
    prior
      ? {
          operation: prior.operation,
          fields: prior.fields === null ? null : JSON.parse(prior.fields),
        }
      : null,
    { operation, fields },
  )
  conn
    .query(
      `INSERT INTO hosted_outbox (id,table_name,row_id,operation,queued_at,fields)
       VALUES (?,?,?,?,?,?) ON CONFLICT(table_name,row_id) DO UPDATE SET
       operation=excluded.operation,queued_at=excluded.queued_at,fields=excluded.fields,
       generation=hosted_outbox.generation+1,attempts=0,last_error=NULL,
       quarantined_at=NULL,quarantine_reason=NULL,kept_values=NULL`,
    )
    .run(
      newRecordId(),
      table,
      rowId,
      merged.operation,
      queuedAt,
      merged.fields === null ? null : JSON.stringify(merged.fields),
    )
}

export function adoptPendingHostedRow(
  conn: Database,
  table: string,
  localId: string,
  hostedId: string,
): void {
  if (localId === hostedId) return
  const local = conn
    .query<OutboxEntry, [string, string]>(
      `SELECT * FROM hosted_outbox WHERE table_name=? AND row_id=?`,
    )
    .get(table, localId)
  if (!local) return
  const hosted = conn
    .query<OutboxEntry, [string, string]>(
      `SELECT * FROM hosted_outbox WHERE table_name=? AND row_id=?`,
    )
    .get(table, hostedId)
  if (!hosted) {
    conn
      .query(
        `UPDATE hosted_outbox SET row_id=?,generation=generation+1,attempts=0,last_error=NULL,
         quarantined_at=NULL,quarantine_reason=NULL,kept_values=NULL
         WHERE table_name=? AND row_id=?`,
      )
      .run(hostedId, table, localId)
    return
  }
  const merged = mergeQueuedHostedChange(
    {
      operation: hosted.operation,
      fields: hosted.fields === null ? null : JSON.parse(hosted.fields),
    },
    {
      operation: local.operation,
      fields: local.fields === null ? null : JSON.parse(local.fields),
    },
  )
  conn
    .query(
      `UPDATE hosted_outbox SET operation=?,queued_at=?,fields=?,generation=generation+1,
       attempts=0,last_error=NULL,quarantined_at=NULL,quarantine_reason=NULL,kept_values=NULL
       WHERE id=?`,
    )
    .run(
      merged.operation,
      local.queued_at < hosted.queued_at ? local.queued_at : hosted.queued_at,
      merged.fields === null ? null : JSON.stringify(merged.fields),
      hosted.id,
    )
  conn.query(`DELETE FROM hosted_outbox WHERE id=?`).run(local.id)
}

export function listHostedOutbox(): OutboxEntry[] {
  return db()
    .query<OutboxEntry, []>(
      `SELECT * FROM hosted_outbox ORDER BY quarantined_at IS NOT NULL,queued_at,id`,
    )
    .all()
}

export function pendingHostedOutboxSummary(): PendingHostedOutbox {
  const row = db()
    .query<{ pending_count: number; newest_queued_at: string | null }, []>(
      `SELECT count(*) AS pending_count,max(queued_at) AS newest_queued_at
       FROM hosted_outbox WHERE quarantined_at IS NULL`,
    )
    .get()!
  return {
    pendingCount: row.pending_count,
    newestQueuedAt: row.newest_queued_at,
  }
}

function retryHostedOutboxEntryOutcome(id: string): 'retried' | 'missing-row' | 'not-quarantined' {
  const entry = db().query<OutboxEntry, [string]>(`SELECT * FROM hosted_outbox WHERE id=?`).get(id)
  if (!entry?.quarantined_at) return 'not-quarantined'
  if (entry.operation === 'upsert' && !loadOutboxChange(db(), entry)) return 'missing-row'
  return writeTransaction((conn) =>
    conn
      .query(
        `UPDATE hosted_outbox SET quarantined_at=NULL,quarantine_reason=NULL,last_error=NULL
           WHERE id=? AND quarantined_at IS NOT NULL`,
      )
      .run(id),
  ).changes > 0
    ? 'retried'
    : 'not-quarantined'
}

function discardHostedOutboxEntry(id: string): boolean {
  return (
    writeTransaction((conn) =>
      conn.query(`DELETE FROM hosted_outbox WHERE id=? AND quarantined_at IS NOT NULL`).run(id),
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

function traceOutcome(
  conn: Database,
  item: PreparedOutboxRow,
  outcome: HostedPushOutcome,
  at: string,
  processKind: OutboxProcessKind,
  operation = item.change.op,
  destination = item.destinationSpaceId,
): void {
  const replacedId = outcome.status === 'rejected' ? undefined : outcome.replacedId
  if (operation === 'upsert' && outcome.status === 'applied' && !replacedId) return
  recordOutboxTrace(conn, {
    table_name: item.entry.table_name,
    row_id: item.entry.row_id,
    operation,
    destination_space_id: destination,
    outcome: replacedId ? 'replaced' : outcome.status,
    reason:
      outcome.status === 'rejected'
        ? outcome.reason
        : replacedId
          ? `replaced interval ${replacedId}`
          : (outcome.reason ?? null),
    generation: item.entry.generation,
    process_kind: processKind,
    created_at: at,
  })
}

function persistAdoptedId(conn: Database, item: PreparedOutboxRow, adoptedId: string): void {
  if (item.change.table === HOSTED_TASK_TABLE && item.change.op === 'upsert') {
    persistTaskAdoptionsOn(conn, [
      {
        table: 'task',
        project: item.change.row.project,
        key: item.change.row.key,
        id: adoptedId,
      },
    ])
    return
  }
  if (item.change.table === HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE)
    conn
      .query(`UPDATE note_acknowledgement SET record_id=? WHERE record_id=?`)
      .run(adoptedId, item.change.id)
  else if (item.change.table === HOSTED_STATUS_EVENT_TABLE)
    conn
      .query(`UPDATE task_status_event SET record_id=? WHERE record_id=?`)
      .run(adoptedId, item.change.id)
}

function recordOutcome(
  item: PreparedOutboxRow,
  outcome: HostedPushOutcome,
  at: string,
  processKind: OutboxProcessKind,
  trace?: { operation: 'upsert' | 'delete'; destination: string | null },
) {
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
      traceOutcome(conn, item, outcome, at, processKind, trace?.operation, trace?.destination)
      if (removed > 0 && outcome.status !== 'rejected' && outcome.adoptedId)
        persistAdoptedId(conn, item, outcome.adoptedId)
      return removed
    } else if (decision.action === 'retry') {
      const updated = conn
        .query(
          `UPDATE hosted_outbox SET attempts=?,last_error=?
           WHERE id=? AND generation=? AND quarantined_at IS NULL`,
        )
        .run(decision.attempts, decision.lastError, entry.id, entry.generation).changes
      traceOutcome(conn, item, outcome, at, processKind, trace?.operation, trace?.destination)
      return updated
    } else if (decision.action === 'quarantine') {
      const updated = conn
        .query(
          `UPDATE hosted_outbox SET attempts=?,last_error=?,quarantined_at=?,quarantine_reason=?
           WHERE id=? AND generation=? AND quarantined_at IS NULL`,
        )
        .run(
          decision.attempts,
          decision.lastError,
          at,
          decision.reason,
          entry.id,
          entry.generation,
        ).changes
      traceOutcome(conn, item, outcome, at, processKind, trace?.operation, trace?.destination)
      return updated
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
      change:
        loaded.change.op === 'upsert' &&
        entry.fields !== null &&
        (loaded.change.table === HOSTED_TASK_TABLE ||
          loaded.change.table === HOSTED_COMMENT_TABLE ||
          loaded.change.table === HOSTED_DOCUMENT_TABLE)
          ? { ...loaded.change, fields: JSON.parse(entry.fields) as string[] }
          : loaded.change,
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

const ROUTING_WAIT_PREFIX = 'waiting on routing:'

export type HostedRoutingWait = { project: string; message: string }

function routingWaitMessage(project: string, reason: string): string {
  if (reason === 'unregistered-project')
    return (
      `${ROUTING_WAIT_PREFIX} project "${project}" is not registered; register it with ` +
      `${PLATFORM_SLUG} project add <path>, or, if it is not a real project, note that such ` +
      'rows cannot be retired yet'
    )
  return `${ROUTING_WAIT_PREFIX} project "${project}" was refused: ${reason}`
}

export function parseHostedRoutingWait(
  message: string | null | undefined,
): HostedRoutingWait | null {
  if (!message?.startsWith(`${ROUTING_WAIT_PREFIX} project "`)) return null
  const project = /^waiting on routing: project "([^"]+)"/.exec(message)?.[1]
  return project ? { project, message } : null
}

function reconcileRoutingErrors(routed: ReturnType<typeof routeOutboxRows>): void {
  writeTransaction((conn) => {
    for (const [project, refusal] of routed.refusals) {
      const reason = routingWaitMessage(project, refusal.reason)
      for (const { entry } of refusal.rows)
        conn
          .query(
            `UPDATE hosted_outbox SET last_error=?
             WHERE id=? AND generation=? AND last_error IS NOT ?`,
          )
          .run(reason, entry.id, entry.generation, reason)
    }
    for (const rows of routed.destinations.values())
      for (const { entry } of rows) {
        if (!parseHostedRoutingWait(entry.last_error)) continue
        conn
          .query(
            `UPDATE hosted_outbox SET last_error=NULL
             WHERE id=? AND generation=? AND last_error=?`,
          )
          .run(entry.id, entry.generation, entry.last_error)
      }
  })
}

function recordBatchOutcomes(
  batch: PreparedOutboxRow[],
  outcomes: HostedPushOutcome[],
  report: HostedOutboxReport,
  clock: () => string,
  processKind: OutboxProcessKind,
): void {
  const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]))
  for (const item of batch) {
    const outcome = byId.get(item.change.id)
    if (!outcome) continue
    const action = recordOutcome(item, outcome, clock(), processKind)
    if (action === 'sent') report.sent++
    else if (action) {
      report.rejected++
      if (action === 'quarantine') report.quarantined++
    }
  }
}

function traceLeaseLostOutcomes(
  batch: PreparedOutboxRow[],
  outcomes: HostedPushOutcome[],
  clock: () => string,
  processKind: OutboxProcessKind,
  operation?: 'upsert' | 'delete',
  destination?: string,
): void {
  const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]))
  writeTransaction((conn) => {
    for (const item of batch) {
      const outcome = byId.get(item.change.id)
      if (!outcome) continue
      const replacedId = outcome.status === 'rejected' ? undefined : outcome.replacedId
      const outcomeReason =
        outcome.status === 'rejected'
          ? outcome.reason
          : replacedId
            ? `replaced interval ${replacedId}`
            : outcome.reason
      recordOutboxTrace(conn, {
        table_name: item.entry.table_name,
        row_id: item.entry.row_id,
        operation: operation ?? item.change.op,
        destination_space_id: destination ?? item.destinationSpaceId,
        outcome: replacedId ? 'replaced' : outcome.status,
        reason: [outcomeReason, 'hosted outbox lease was lost after delivery']
          .filter(Boolean)
          .join('; '),
        generation: item.entry.generation,
        process_kind: processKind,
        created_at: clock(),
      })
    }
  })
}

async function drainDestinations(
  destinations: Map<string, PreparedOutboxRow[]>,
  dependencies: DrainDependencies,
  report: HostedOutboxReport,
): Promise<boolean> {
  const clock = dependencies.clock ?? nowIso
  const processKind = dependencies.processKind ?? 'command'
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
        if (!(await deliverOutboxBatch(batch, spaceId, dependencies, report, clock, processKind)))
          return false
      }
    }
  }
  return true
}

async function deliverOutboxBatch(
  batch: PreparedOutboxRow[],
  spaceId: string,
  dependencies: DrainDependencies,
  report: HostedOutboxReport,
  clock: () => string,
  processKind: OutboxProcessKind,
): Promise<boolean> {
  let outcomes: HostedPushOutcome[]
  try {
    dependencies.assertLock?.()
    outcomes = await (dependencies.push ?? hostedPushChanges)(
      batch.map((item) => item.change),
      { recordSpace: spaceId },
    )
  } catch {
    return false
  }
  try {
    dependencies.assertLock?.()
  } catch (error) {
    if (error instanceof StoredLeaseLostError)
      traceLeaseLostOutcomes(batch, outcomes, clock, processKind)
    return false
  }
  recordBatchOutcomes(batch, outcomes, report, clock, processKind)
  return true
}

async function removeMovedIntervals(
  destinations: Map<string, PreparedOutboxRow[]>,
  dependencies: DrainDependencies,
  report: HostedOutboxReport,
): Promise<boolean> {
  const push = dependencies.push ?? hostedPushChanges
  const clock = dependencies.clock ?? nowIso
  const processKind = dependencies.processKind ?? 'command'
  const blocked = new Set<PreparedOutboxRow>()
  for (const [destination, rows] of destinations) {
    for (const item of rows) {
      const result = await removeMovedInterval(
        item,
        destination,
        push,
        clock,
        processKind,
        dependencies.assertLock,
        report,
      )
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
  processKind: OutboxProcessKind,
  assertLock: (() => void) | undefined,
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
    assertLock?.()
    outcomes = await push([{ table: HOSTED_INTERVAL_TABLE, id: item.change.id, op: 'delete' }], {
      recordSpace: item.acknowledgedSpaceId,
    })
    try {
      assertLock?.()
    } catch (error) {
      if (error instanceof StoredLeaseLostError)
        traceLeaseLostOutcomes(
          [item],
          outcomes,
          clock,
          processKind,
          'delete',
          item.acknowledgedSpaceId,
        )
      return 'failed'
    }
  } catch {
    return 'failed'
  }
  const outcome = outcomes[0]
  if (!outcome) return 'failed'
  if (outcome.status === 'applied' || outcome.status === 'duplicate') {
    writeTransaction((conn) => {
      conn
        .query(`UPDATE interval SET hosted_space_id=NULL WHERE record_id=? AND hosted_space_id=?`)
        .run(item.change.id, item.acknowledgedSpaceId)
      traceOutcome(conn, item, outcome, clock(), processKind, 'delete', item.acknowledgedSpaceId)
    })
    item.acknowledgedSpaceId = null
    return 'ready'
  }
  const action = recordOutcome(item, outcome, clock(), processKind, {
    operation: 'delete',
    destination: item.acknowledgedSpaceId,
  })
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

/** Classify selected rows without acquiring the drainer lease or changing the store. */
export async function hostedRoutingWaitForEntries(
  entries: OutboxEntry[],
  dependencies: Pick<DrainDependencies, 'identity' | 'registered'> = {},
): Promise<HostedRoutingWait | null> {
  let rows = prepareOutboxRows(entries).rows
  if (!rows.length) return null
  const identity = await (dependencies.identity ?? hostedTaskIdentity)()
  const accepted = new Set(
    identity.capabilities?.spacePushTables ?? [HOSTED_TASK_TABLE, HOSTED_STATUS_EVENT_TABLE],
  )
  rows = rows.filter((row) => accepted.has(row.change.table))
  const { refusals } = routeOutboxRows(rows, (dependencies.registered ?? projects)(), identity)
  for (const [project, refusal] of refusals)
    return parseHostedRoutingWait(routingWaitMessage(project, refusal.reason))
  return null
}

async function drainHostedOutboxHeld(
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
    if (entry.quarantined_at) continue
    const removed = writeTransaction((conn) => {
      const changes = conn
        .query(`DELETE FROM hosted_outbox WHERE id=? AND generation=?`)
        .run(entry.id, entry.generation).changes
      recordOutboxTrace(conn, {
        table_name: entry.table_name,
        row_id: entry.row_id,
        operation: entry.operation,
        destination_space_id: entry.routing_space_id,
        outcome: 'dropped',
        reason: 'machine row is gone',
        generation: entry.generation,
        process_kind: dependencies.processKind ?? 'command',
        created_at: (dependencies.clock ?? nowIso)(),
      })
      return changes
    })
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
  reconcileRoutingErrors(partitioned)
  recordRoutingWaits(partitioned.refusals, report)
  const hostedReachable = (await removeMovedIntervals(
    partitioned.destinations,
    dependencies,
    report,
  ))
    ? await drainDestinations(partitioned.destinations, dependencies, report)
    : false
  Object.defineProperty(report, 'hostedReachable', { value: hostedReachable })
  return report
}

export async function drainHostedOutbox(
  dependencies: DrainDependencies = {},
): Promise<HostedOutboxReport> {
  const holder = `outbox:${process.pid}:${newRecordId()}`
  if (!acquireStoredLease(HOSTED_OUTBOX_LEASE_KEY, holder, HOSTED_OUTBOX_LEASE_MS)) {
    return {
      queued: loadPendingOutboxRows().length,
      sent: 0,
      rejected: 0,
      quarantined: 0,
      dropped: 0,
      waitingOnRouting: {},
      waitingOnHostedHub: {},
      skippedCapability: false,
      lockAcquired: false,
    }
  }
  const held = await holdStoredLease({
    key: HOSTED_OUTBOX_LEASE_KEY,
    holder,
    durationMs: HOSTED_OUTBOX_LEASE_MS,
    renewEveryMs: HOSTED_OUTBOX_LEASE_RENEW_MS,
    lostMessage: () => 'hosted outbox lease was lost during the drain',
    work: (guard) => drainHostedOutboxHeld({ ...dependencies, assertLock: guard.assertHeld }),
  })
  if (held.value) return held.value
  return {
    queued: loadPendingOutboxRows().length,
    sent: 0,
    rejected: 0,
    quarantined: 0,
    dropped: 0,
    waitingOnRouting: {},
    waitingOnHostedHub: {},
    skippedCapability: false,
    lockAcquired: false,
  }
}

export function hostedOutboxLine(report: HostedOutboxReport): string {
  if (report.lockAcquired === false)
    return `queued=${report.queued} skipped: another process is draining`
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
    ? [
        `hosted outbox ${count} quarantined; run \`${PLATFORM_SLUG} record outbox\` and \`${PLATFORM_SLUG} record outbox retry hub:<ID>\``,
      ]
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

export function showHostedOutboxEntry(id: string): string[] {
  const row = listHostedOutbox().find((entry) => entry.id === id)
  if (!row) throw new Error(`no outbox entry ${id}`)
  return [
    JSON.stringify(
      {
        ...row,
        kept_values: row.kept_values ? JSON.parse(row.kept_values) : null,
      },
      null,
      2,
    ),
  ]
}

export function discardHostedOutboxEntryCommand(id: string): string[] {
  if (!discardHostedOutboxEntry(id))
    throw new Error(
      `outbox entry ${id} is not quarantined; use \`${PLATFORM_SLUG} record outbox retry hub:${id}\``,
    )
  return [`outbox entry ${id} discarded`]
}

export function retryHostedOutboxEntryCommand(id: string): string[] {
  const outcome = retryHostedOutboxEntryOutcome(id)
  if (outcome === 'missing-row')
    throw new Error(
      `outbox entry ${id} has no machine row; use \`${PLATFORM_SLUG} record outbox show hub:${id}\` then \`${PLATFORM_SLUG} record outbox discard hub:${id}\``,
    )
  if (outcome !== 'retried') throw new Error(`outbox entry ${id} is not quarantined and unsent`)
  return [`outbox entry ${id} queued for retry`]
}

export function hostedOutboxLines(json = false): string[] {
  const rows = listHostedOutbox()
  if (json) return [JSON.stringify(rows)]
  if (!rows.length) return ['hosted outbox is empty']
  return [
    ...hostedOutboxSummaryLines(rows),
    ...rows.map(
      (row) =>
        `${row.id} ${row.table_name} ${row.row_id} ${row.operation} attempts=${row.attempts} ` +
        `${row.quarantined_at ? `quarantined=${row.quarantine_reason}` : `queued=${row.queued_at}`}`,
    ),
  ]
}

export function hostedOutboxSummaryLines(
  rows: readonly OutboxEntry[] = listHostedOutbox(),
): string[] {
  const blocked = new Map<string, { count: number; oldest: string; remedy: string }>()
  for (const row of rows) {
    const wait = parseHostedRoutingWait(row.last_error)
    if (!wait) continue
    const current = blocked.get(wait.project)
    blocked.set(wait.project, {
      count: (current?.count ?? 0) + 1,
      oldest: current && current.oldest < row.queued_at ? current.oldest : row.queued_at,
      remedy: wait.message,
    })
  }
  return [...blocked.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([project, summary]) =>
        `hub outbox blocked: project="${project}" rows=${summary.count} oldest=${summary.oldest}; ${summary.remedy}`,
    )
}
