import type { Database } from 'bun:sqlite'

export const DELETED_ON_HOSTED_RECORD_REASON = 'row was deleted on the hosted record'

export const HOSTED_MACHINE_TABLES = {
  hub_task: 'task',
  hub_task_comment: 'task_comment',
  hub_task_document: 'task_document',
  hub_task_status_event: 'task_status_event',
} as const

export type ReconciledHostedTable = keyof typeof HOSTED_MACHINE_TABLES

export type PendingHostedEdit = {
  operation: 'upsert' | 'delete'
  fields: string | null
  quarantined_at: string | null
}

export function pendingHostedEdit(
  conn: Database,
  table: string,
  id: string,
): PendingHostedEdit | null {
  return (
    conn
      .query<PendingHostedEdit, [string, string]>(
        `SELECT operation,fields,quarantined_at FROM hosted_outbox WHERE table_name=? AND row_id=?`,
      )
      .get(table, id) ?? null
  )
}

export function pendingEditSkipsPull(pending: PendingHostedEdit | null): boolean {
  return Boolean(pending && (pending.operation === 'delete' || pending.fields === null))
}

export function capturePendingFields(
  table: string,
  row: Record<string, unknown> | null,
  pending: PendingHostedEdit | null,
): Record<string, unknown> | null {
  if (!row || !pending?.fields || !(table in HOSTED_MACHINE_TABLES)) return null
  const fields = new Set(JSON.parse(pending.fields) as string[])
  fields.add('updated_at')
  if (table === 'hub_task') {
    fields.add('last_seen')
    if (fields.has('parent_key')) fields.add('parent_record_id')
    if (fields.has('status') || fields.has('status_category')) {
      fields.add('status')
      fields.add('status_category')
      fields.add('closed_at')
      fields.add('last_seen')
    }
  }
  return Object.fromEntries(
    [...fields].filter((field) => field in row).map((field) => [field, row[field]]),
  )
}

export function restorePendingFields(
  conn: Database,
  table: string,
  id: string,
  values: Record<string, unknown> | null,
): void {
  if (!values || !(table in HOSTED_MACHINE_TABLES)) return
  const columns = Object.keys(values)
  if (!columns.length) return
  const bindings = columns.map((column) => values[column]) as Array<
    string | number | bigint | boolean | Uint8Array | null
  >
  conn
    .query(
      `UPDATE ${HOSTED_MACHINE_TABLES[table as ReconciledHostedTable]} SET ${columns.map((column) => `${column}=?`).join(',')} WHERE record_id=?`,
    )
    .run(...bindings, id)
}

export type ReconcilePulledRowResult =
  | { kind: 'skipped'; before: Record<string, unknown> | null; after: Record<string, unknown> | null }
  | { kind: 'deleted'; before: Record<string, unknown> | null; after: null }
  | { kind: 'upserted'; before: Record<string, unknown> | null; after: Record<string, unknown> | null }

export function reconcilePulledRow(
  conn: Database,
  input: {
    table: ReconciledHostedTable
    id: string
    operation: 'upsert' | 'delete'
    current: () => Record<string, unknown> | null
    apply: () => void
    remove: () => void
    at?: string
  },
): ReconcilePulledRowResult {
  const pending = pendingHostedEdit(conn, input.table, input.id)
  const before = input.current()
  if (input.operation === 'delete') {
    if (pending?.operation === 'delete') return { kind: 'skipped', before, after: before }
    if (pending?.operation === 'upsert') {
      const kept = pending.fields === null
        ? before
        : before
          ? Object.fromEntries(
              (JSON.parse(pending.fields) as string[])
                .filter((field) => field in before)
                .map((field) => [field, before[field]]),
            )
          : null
      conn
        .query(
          `UPDATE hosted_outbox SET kept_values=?,last_error=?,quarantined_at=?,quarantine_reason=?
           WHERE table_name=? AND row_id=? AND operation='upsert'`,
        )
        .run(
          kept === null ? null : JSON.stringify(kept),
          DELETED_ON_HOSTED_RECORD_REASON,
          input.at ?? new Date().toISOString(),
          DELETED_ON_HOSTED_RECORD_REASON,
          input.table,
          input.id,
        )
    }
    input.remove()
    return { kind: 'deleted', before, after: null }
  }
  if (pendingEditSkipsPull(pending)) return { kind: 'skipped', before, after: before }
  const protectedValues = capturePendingFields(input.table, before, pending)
  input.apply()
  restorePendingFields(conn, input.table, input.id, protectedValues)
  return { kind: 'upserted', before, after: input.current() }
}
