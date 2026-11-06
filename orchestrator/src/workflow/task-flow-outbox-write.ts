// concern: task-flow-outbox-write
/** Refreshes the one pending outbox mutation for a task-flow record, or inserts it. */
import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { insertOutboxRow, refreshPendingOutboxRow } from '../record/outbox-enqueue.ts'
import { stringifyOutboxPayload } from '../record/outbox-sanitize.ts'

export function writePendingTaskFlowOutbox(
  database: Database,
  kind: 'task_flow' | 'task_flow_stage',
  rowId: string,
  value: Record<string, unknown>,
  at: string,
): void {
  const payload = stringifyOutboxPayload(kind, value)
  const pending = database
    .query<{ id: number }, [string, string]>(
      `SELECT id FROM outbox WHERE kind=? AND row_id=? AND synced_at IS NULL
       AND quarantined_at IS NULL AND retired_at IS NULL ORDER BY id LIMIT 1`,
    )
    .get(kind, rowId)
  if (pending) {
    refreshPendingOutboxRow(database, { id: pending.id, payload, createdAt: at })
    return
  }
  insertOutboxRow(database, {
    recordId: newRecordId(),
    kind,
    rowId,
    payload,
    createdAt: at,
  })
}
