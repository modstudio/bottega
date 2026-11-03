// concern: task-flow-outbox
/** Knows how a local task flow becomes an ordered hosted-record mutation. Must not know Postgres. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { nowIso } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import { stringifyOutboxPayload } from '../record/outbox-sanitize.ts'

type TaskFlowRow = {
  record_id: string
  project_record_id: string
  project_name: string
  task_record_id: string
  state: string
  open_stage_cursor_record_id: string | null
  opening_machine_id: string
  updated_machine_id: string
  revision: number
  created_at: string
  updated_at: string
}

export function enqueueTaskFlowRecord(database: Database, flowRecordId: string): boolean {
  const row = database
    .query<TaskFlowRow, [string]>(
      `SELECT flow.*,project.name project_name FROM task_flow flow
       JOIN project ON project.record_id=flow.project_record_id WHERE flow.record_id=?`,
    )
    .get(flowRecordId)
  if (!row) throw new Error(`task flow ${flowRecordId} does not exist and cannot be enqueued`)
  const at = nowIso()
  const payload = stringifyOutboxPayload('task_flow', {
    id: row.record_id,
    spaceId: PLATFORM_SPACE_ID,
    projectId: row.project_record_id,
    projectName: row.project_name,
    taskId: row.task_record_id,
    state: row.state,
    openStageRecordId: row.open_stage_cursor_record_id,
    openingMachineId: row.opening_machine_id,
    updatedMachineId: row.updated_machine_id,
    machineId: machineId(),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
  const pending = database
    .query<{ id: number }, [string]>(
      `SELECT id FROM outbox WHERE kind='task_flow' AND row_id=? AND synced_at IS NULL
       AND quarantined_at IS NULL AND retired_at IS NULL ORDER BY id LIMIT 1`,
    )
    .get(row.record_id)
  if (pending) {
    database
      .query('UPDATE outbox SET payload=?,created_at=?,attempts=0,last_error=NULL WHERE id=?')
      .run(payload, at, pending.id)
    return true
  }
  database
    .query(
      "INSERT INTO outbox (record_id,kind,row_id,payload,created_at) VALUES (?,'task_flow',?,?,?)",
    )
    .run(newRecordId(), row.record_id, payload, at)
  return true
}
