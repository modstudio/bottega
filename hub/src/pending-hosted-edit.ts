import type { Database } from 'bun:sqlite'
import { DELETED_ON_HOSTED_RECORD_REASON } from './hosted-delete.ts'
import { mergeNoteAnchors } from './note-anchor-merge.ts'
import { HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE, HOSTED_NOTE_TABLE } from './push-contract.ts'

export const HOSTED_MACHINE_TABLES = {
  hub_task: 'task',
  hub_task_comment: 'task_comment',
  hub_task_document: 'task_document',
  hub_task_status_event: 'task_status_event',
  [HOSTED_NOTE_TABLE]: 'note',
  [HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE]: 'note_acknowledgement',
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

function capturePendingFields(
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

function restorePendingFields(
  conn: Database,
  table: string,
  id: string,
  values: Record<string, unknown> | null,
): void {
  if (!values || !(table in HOSTED_MACHINE_TABLES)) return
  if (table === 'hub_note' && typeof values.anchors === 'string') {
    const hosted = conn
      .query<{ anchors: string }, [string]>('SELECT anchors FROM note WHERE record_id=?')
      .get(id)
    if (hosted) {
      const merged = mergeNoteAnchors(
        JSON.parse(hosted.anchors) as Array<{ id?: string }>,
        JSON.parse(values.anchors) as Array<{ id?: string }>,
      )
      values.anchors = JSON.stringify(merged.anchors)
      values.sightings = merged.sightings
    }
  }
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
  | {
      kind: 'skipped'
      before: Record<string, unknown> | null
      after: Record<string, unknown> | null
    }
  | { kind: 'deleted'; before: Record<string, unknown> | null; after: null }
  | {
      kind: 'upserted'
      before: Record<string, unknown> | null
      after: Record<string, unknown> | null
    }

function quarantinePendingUpsert(
  conn: Database,
  table: ReconciledHostedTable,
  id: string,
  row: Record<string, unknown> | null,
  at: string,
): void {
  const pending = pendingHostedEdit(conn, table, id)
  if (pending?.operation !== 'upsert') return
  const kept =
    pending.fields === null
      ? row
      : row
        ? Object.fromEntries(
            (JSON.parse(pending.fields) as string[])
              .filter((field) => field in row)
              .map((field) => [field, row[field]]),
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
      at,
      DELETED_ON_HOSTED_RECORD_REASON,
      table,
      id,
    )
}

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
    const at = input.at ?? new Date().toISOString()
    quarantinePendingUpsert(conn, input.table, input.id, before, at)
    if (input.table === 'hub_task') {
      for (const [table, machine] of [
        ['hub_task_comment', 'task_comment'],
        ['hub_task_document', 'task_document'],
      ] as const) {
        for (const child of conn
          .query<Record<string, unknown> & { record_id: string }, [string]>(
            `SELECT * FROM ${machine} WHERE task_record_id=?`,
          )
          .all(input.id))
          quarantinePendingUpsert(conn, table, child.record_id, child, at)
      }
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
