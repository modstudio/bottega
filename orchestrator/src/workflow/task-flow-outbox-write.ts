// concern: task-flow-outbox-write
/** Refreshes the one pending outbox mutation for a task-flow record, or inserts it. */
import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { insertOutboxRow } from '../record/outbox-enqueue.ts'
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
    database
      .query('UPDATE outbox SET payload=?,created_at=?,attempts=0,last_error=NULL WHERE id=?')
      .run(payload, at, pending.id)
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
