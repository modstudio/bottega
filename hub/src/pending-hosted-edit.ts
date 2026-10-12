import type { Database } from 'bun:sqlite'

const MACHINE_TABLES: Record<string, string> = {
  hub_task: 'task',
  hub_task_comment: 'task_comment',
  hub_task_document: 'task_document',
}

export type PendingHostedEdit = { operation: 'upsert' | 'delete'; fields: string | null }

export function pendingHostedEdit(
  conn: Database,
  table: string,
  id: string,
): PendingHostedEdit | null {
  return (
    conn
      .query<PendingHostedEdit, [string, string]>(
        `SELECT operation,fields FROM hosted_outbox WHERE table_name=? AND row_id=?`,
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
  if (!row || !pending?.fields || !MACHINE_TABLES[table]) return null
  const fields = new Set(JSON.parse(pending.fields) as string[])
  fields.add('updated_at')
  if (table === 'hub_task') {
    fields.add('last_seen')
    if (fields.has('status') || fields.has('status_category')) fields.add('closed_at')
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
  if (!values) return
  const columns = Object.keys(values)
  if (!columns.length) return
  const bindings = columns.map((column) => values[column]) as Array<
    string | number | bigint | boolean | Uint8Array | null
  >
  conn
    .query(
      `UPDATE ${MACHINE_TABLES[table]} SET ${columns.map((column) => `${column}=?`).join(',')} WHERE record_id=?`,
    )
    .run(...bindings, id)
}
