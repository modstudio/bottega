import type { Database } from 'bun:sqlite'
import { decideOutboxLifecycle } from '../../shared/outbox-lifecycle.ts'
import { newRecordId } from '../../shared/record/schema.ts'
import { db, nowIso, writeTransaction } from './db.ts'
import { projects } from './projects.ts'
import { hostedPushChanges, hostedTaskIdentity } from './task-client.ts'
import { partitionProjectRows } from './task-project-space.ts'

export const HOSTED_OUTBOX_BATCH_SIZE = 500
export const HOSTED_STATUS_EVENT_TABLE = 'hub_task_status_event'

export type OutboxEntry = {
  id: string
  table_name: string
  row_id: string
  operation: 'upsert' | 'delete'
  queued_at: string
  attempts: number
  last_error: string | null
  sent_at: string | null
  quarantined_at: string | null
  quarantine_reason: string | null
}

export type PushChange = {
  table: typeof HOSTED_STATUS_EVENT_TABLE
  id: string
  op: 'upsert' | 'delete'
  row?: Record<string, unknown>
}

export type PushOutcome =
  | { id: string; status: 'applied' | 'duplicate' }
  | { id: string; status: 'rejected'; reason: string }

export type HostedOutboxReport = {
  queued: number
  sent: number
  rejected: number
  quarantined: number
  skippedCapability: boolean
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
       VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING`,
    )
    .run(newRecordId(), table, rowId, operation, queuedAt)
}

export function listHostedOutbox(): OutboxEntry[] {
  return db()
    .query<OutboxEntry, []>(
      `SELECT * FROM hosted_outbox WHERE sent_at IS NULL
       ORDER BY quarantined_at IS NOT NULL,queued_at,id`,
    )
    .all()
}

export function retryHostedOutboxEntry(id: string): boolean {
  return (
    writeTransaction((conn) =>
      conn
        .query(
          `UPDATE hosted_outbox SET quarantined_at=NULL,quarantine_reason=NULL,last_error=NULL
           WHERE id=? AND sent_at IS NULL AND quarantined_at IS NOT NULL`,
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

function currentStatusEvent(entry: OutboxEntry): CurrentStatusEvent | null {
  const row = db()
    .query<
      {
        record_id: string
        task_key: string
        task_record_id: string
        at: string
        from_status: string | null
        to_status: string
        project: string
      },
      [string]
    >(
      `SELECT e.record_id,e.task_key,e.task_record_id,e.at,e.from_status,e.to_status,t.project
       FROM task_status_event e JOIN task t ON t.record_id=e.task_record_id
       WHERE e.record_id=?`,
    )
    .get(entry.row_id)
  if (!row) return null
  return {
    project_name: row.project,
    id: row.record_id,
    task_key: row.task_key,
    task_id: row.task_record_id,
    at: row.at,
    from_status: row.from_status,
    to_status: row.to_status,
    created_at: row.at,
    updated_at: row.at,
    deleted_at: null,
  }
}

function recordOutcome(entry: OutboxEntry, outcome: PushOutcome, at: string) {
  const decision = decideOutboxLifecycle(
    entry.attempts,
    outcome.status === 'rejected'
      ? { kind: 'rejected', reason: outcome.reason }
      : { kind: outcome.status },
  )
  writeTransaction((conn) => {
    if (decision.action === 'sent') {
      conn
        .query(`UPDATE hosted_outbox SET sent_at=?,last_error=NULL WHERE id=? AND sent_at IS NULL`)
        .run(at, entry.id)
    } else if (decision.action === 'retry') {
      conn
        .query(`UPDATE hosted_outbox SET attempts=?,last_error=? WHERE id=? AND sent_at IS NULL`)
        .run(decision.attempts, decision.lastError, entry.id)
    } else if (decision.action === 'quarantine') {
      conn
        .query(
          `UPDATE hosted_outbox SET attempts=?,last_error=?,quarantined_at=?,quarantine_reason=?
           WHERE id=? AND sent_at IS NULL`,
        )
        .run(decision.attempts, decision.lastError, at, decision.reason, entry.id)
    }
  })
  return decision.action
}

export async function drainHostedOutbox(
  dependencies: {
    identity?: typeof hostedTaskIdentity
    push?: typeof hostedPushChanges
    clock?: () => string
  } = {},
): Promise<HostedOutboxReport> {
  const entries = db()
    .query<OutboxEntry, []>(
      `SELECT * FROM hosted_outbox
       WHERE sent_at IS NULL AND quarantined_at IS NULL ORDER BY queued_at,id`,
    )
    .all()
  const report: HostedOutboxReport = {
    queued: entries.length,
    sent: 0,
    rejected: 0,
    quarantined: 0,
    skippedCapability: false,
  }
  if (!entries.length) return report
  const identity = await (dependencies.identity ?? hostedTaskIdentity)()
  if (identity.capabilities?.spacePush !== true) {
    report.skippedCapability = true
    return report
  }
  const rows: Array<{
    entry: OutboxEntry
    project_name: string | null
    change: PushChange
  }> = []
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
    if (row)
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
  const partitioned = partitionProjectRows(rows, projects(), identity)
  for (const selected of partitioned.refusals.values()) {
    for (const item of selected.rows) {
      const action = recordOutcome(
        item.entry,
        { id: item.entry.id, status: 'rejected', reason: selected.reason },
        (dependencies.clock ?? nowIso)(),
      )
      report.rejected++
      if (action === 'quarantine') report.quarantined++
    }
  }
  for (const [spaceId, selected] of partitioned.destinations) {
    for (let index = 0; index < selected.length; index += HOSTED_OUTBOX_BATCH_SIZE) {
      const slice = selected.slice(index, index + HOSTED_OUTBOX_BATCH_SIZE)
      let outcomes: PushOutcome[]
      try {
        outcomes = await (dependencies.push ?? hostedPushChanges)(
          slice.map((item) => item.change),
          { recordSpace: spaceId },
        )
      } catch {
        break
      }
      const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]))
      for (const item of slice) {
        const outcome = byId.get(item.change.id)
        if (!outcome) continue
        const action = recordOutcome(item.entry, outcome, (dependencies.clock ?? nowIso)())
        if (action === 'sent') report.sent++
        else {
          report.rejected++
          if (action === 'quarantine') report.quarantined++
        }
      }
    }
  }
  return report
}

export function hostedOutboxLine(report: HostedOutboxReport): string {
  if (report.skippedCapability)
    return `queued=${report.queued} skipped: hosted hub does not advertise spacePush`
  return `queued=${report.queued} sent=${report.sent} rejected=${report.rejected} quarantined=${report.quarantined}`
}

export function hostedOutboxDoctorLine(): string | null {
  const count = db()
    .query<{ count: number }, []>(
      `SELECT count(*) count FROM hosted_outbox
       WHERE sent_at IS NULL AND quarantined_at IS NOT NULL`,
    )
    .get()!.count
  return count
    ? `hosted outbox ${count} quarantined; run \`hub outbox\` and \`hub outbox retry <ID>\``
    : null
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
