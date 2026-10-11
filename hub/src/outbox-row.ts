import type { Database } from 'bun:sqlite'
import type { TaskRow } from './task.ts'
import { hostedTaskFromTaskRow } from './task-hosted-row.ts'
import {
  HOSTED_STATUS_EVENT_TABLE,
  HOSTED_TASK_TABLE,
  type HostedPushChange,
} from './push-contract.ts'

type OutboxPointer = {
  table_name: string
  row_id: string
  operation: 'upsert' | 'delete'
}

export type LoadedOutboxChange = {
  projectName: string | null
  change: HostedPushChange
}

function currentTask(conn: Database, id: string): LoadedOutboxChange | null {
  const row = conn.query<TaskRow, [string]>(`SELECT * FROM task WHERE record_id=?`).get(id)
  return row
    ? {
        projectName: row.project,
        change: { table: HOSTED_TASK_TABLE, id, op: 'upsert', row: hostedTaskFromTaskRow(row, id) },
      }
    : null
}

function currentStatusEvent(conn: Database, id: string): LoadedOutboxChange | null {
  const row = conn
    .query<
      {
        id: string
        task_key: string
        task_id: string
        at: string
        from_status: string | null
        to_status: string
        project_name: string
      },
      [string]
    >(
      `SELECT e.record_id id,e.task_key,e.task_record_id task_id,e.at,e.from_status,e.to_status,
        t.project project_name FROM task_status_event e
       JOIN task t ON t.record_id=e.task_record_id WHERE e.record_id=?`,
    )
    .get(id)
  return row
    ? {
        projectName: row.project_name,
        change: {
          table: HOSTED_STATUS_EVENT_TABLE,
          id,
          op: 'upsert',
          row: { ...row, created_at: row.at, updated_at: row.at, deleted_at: null },
        },
      }
    : null
}

export function loadOutboxChange(
  conn: Database,
  pointer: OutboxPointer,
): LoadedOutboxChange | null {
  if (pointer.operation === 'delete')
    return {
      projectName: null,
      change: {
        table:
          pointer.table_name === HOSTED_TASK_TABLE ? HOSTED_TASK_TABLE : HOSTED_STATUS_EVENT_TABLE,
        id: pointer.row_id,
        op: 'delete',
      },
    }
  return pointer.table_name === HOSTED_TASK_TABLE
    ? currentTask(conn, pointer.row_id)
    : currentStatusEvent(conn, pointer.row_id)
}
