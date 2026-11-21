import type { Database } from 'bun:sqlite'
import { removeQueuedHostedChangeField } from './outbox.ts'

export function demoteOtherTaskDocumentRoleHolders(
  conn: Database,
  taskRecordId: string,
  role: string,
  writtenDocumentId: string,
): void {
  const holders = conn
    .query<{ record_id: string }, [string, string, string]>(
      `SELECT record_id FROM task_document
       WHERE task_record_id=? AND role=? AND record_id<>?`,
    )
    .all(taskRecordId, role, writtenDocumentId)
  conn
    .query(
      `UPDATE task_document SET role=NULL
       WHERE task_record_id=? AND role=? AND record_id<>?`,
    )
    .run(taskRecordId, role, writtenDocumentId)
  for (const holder of holders)
    removeQueuedHostedChangeField(conn, 'hub_task_document', holder.record_id, 'role', [
      'role',
      'title',
      'body',
      'version',
    ])
}
