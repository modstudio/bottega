import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../shared/record/schema.ts'
import { db, nowIso, writeTransaction } from './db.ts'

export const OUTBOX_TRACE_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000

export type OutboxProcessKind = 'collector' | 'command'
type OutboxTraceOutcome = 'applied' | 'duplicate' | 'replaced' | 'rejected' | 'dropped'

export type OutboxTraceRow = {
  id: string
  table_name: string
  row_id: string
  operation: 'upsert' | 'delete'
  destination_space_id: string | null
  outcome: OutboxTraceOutcome
  reason: string | null
  generation: number
  process_kind: OutboxProcessKind
  created_at: string
}

export function recordOutboxTrace(conn: Database, trace: Omit<OutboxTraceRow, 'id'>): void {
  conn
    .query(
      `INSERT INTO hosted_outbox_trace
       (id,table_name,row_id,operation,destination_space_id,outcome,reason,generation,
        process_kind,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      newRecordId(),
      trace.table_name,
      trace.row_id,
      trace.operation,
      trace.destination_space_id,
      trace.outcome,
      trace.reason,
      trace.generation,
      trace.process_kind,
      trace.created_at,
    )
}

export function pruneOutboxTrace(at = nowIso(), retentionMs = OUTBOX_TRACE_RETENTION_MS): number {
  const cutoff = new Date(new Date(at).getTime() - retentionMs).toISOString()
  return writeTransaction((conn) =>
    conn.query(`DELETE FROM hosted_outbox_trace WHERE created_at < ?`).run(cutoff),
  ).changes
}

export function listOutboxTrace(rowId?: string): OutboxTraceRow[] {
  return rowId
    ? db()
        .query<OutboxTraceRow, [string]>(
          `SELECT * FROM hosted_outbox_trace WHERE row_id=? ORDER BY created_at DESC,id DESC`,
        )
        .all(rowId)
    : db()
        .query<OutboxTraceRow, []>(
          `SELECT * FROM hosted_outbox_trace ORDER BY created_at DESC,id DESC`,
        )
        .all()
}

export function runOutboxTraceCommand(argv: string[]): string[] {
  const json = argv.includes('--json')
  const rowIndex = argv.indexOf('--row')
  const rowId = rowIndex === -1 ? undefined : argv[rowIndex + 1]
  if (rowIndex !== -1 && !rowId) throw new Error('usage: hub outbox trace [--row ID] [--json]')
  const allowed = new Set(['trace', '--json', '--row', rowId])
  if (argv.slice(1).some((argument) => !allowed.has(argument)))
    throw new Error('usage: hub outbox trace [--row ID] [--json]')
  const rows = listOutboxTrace(rowId)
  if (json) return [JSON.stringify(rows)]
  if (!rows.length) return ['hosted outbox trace is empty']
  return rows.map(
    (row) =>
      `${row.created_at} ${row.table_name} ${row.row_id} ${row.operation} ` +
      `${row.destination_space_id ?? '-'} ${row.outcome}` +
      (row.reason ? ` ${row.reason}` : ''),
  )
}
