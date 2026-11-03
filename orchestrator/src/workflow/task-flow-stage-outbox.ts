// concern: task-flow-stage-outbox
/** Knows how a keyed local workflow cursor becomes a hosted task-flow stage mutation. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { nowIso } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import { stringifyOutboxPayload } from '../record/outbox-sanitize.ts'

type StageRow = {
  record_id: string
  project_record_id: string | null
  project_name: string | null
  task_flow_record_id: string | null
  workflow_slug: string
  mode_slug: string
  workflow_version_record_id: string
  catalogue_version_record_id: string
  args: string
  ordinal: number
  step_slug: string
  state: string
  closed: string
  total_steps: number
  opened_machine_id: string
  taken_over_from_machine_id: string | null
  last_advanced_machine_id: string
  revision: number
  created_at: string
  updated_at: string
  workflow_key: string
  task_record_id: string | null
}

export function enqueueTaskFlowStageRecord(database: Database, cursorRecordId: string): boolean {
  const row = database
    .query<StageRow, [string]>(
      `SELECT cursor.*,project.name project_name FROM workflow_cursor cursor
       LEFT JOIN project ON project.record_id=cursor.project_record_id WHERE cursor.record_id=?`,
    )
    .get(cursorRecordId)
  if (!row)
    throw new Error(`workflow cursor ${cursorRecordId} does not exist and cannot be enqueued`)
  if (!row.workflow_key || !row.task_record_id || !row.task_flow_record_id) return false
  if (!row.project_record_id || !row.project_name)
    throw new Error(
      `workflow cursor ${cursorRecordId} has no project identity and cannot be enqueued`,
    )
  const at = nowIso()
  const payload = stringifyOutboxPayload('task_flow_stage', {
    id: row.record_id,
    spaceId: PLATFORM_SPACE_ID,
    projectId: row.project_record_id,
    projectName: row.project_name,
    flowRecordId: row.task_flow_record_id,
    workflow: row.workflow_slug,
    mode: row.mode_slug,
    workflowVersionId: row.workflow_version_record_id,
    catalogueVersionId: row.catalogue_version_record_id,
    arguments: JSON.parse(row.args),
    activeOrdinal: row.ordinal,
    activeSlug: row.step_slug,
    state: row.state,
    closedStepNotes: JSON.parse(row.closed),
    totalSteps: row.total_steps,
    openedMachineId: row.opened_machine_id,
    takenOverFromMachineId: row.taken_over_from_machine_id,
    lastAdvancedMachineId: row.last_advanced_machine_id,
    machineId: machineId(),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
  const pending = database
    .query<{ id: number }, [string]>(
      `SELECT id FROM outbox WHERE kind='task_flow_stage' AND row_id=? AND synced_at IS NULL
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
      "INSERT INTO outbox (record_id,kind,row_id,payload,created_at) VALUES (?,'task_flow_stage',?,?,?)",
    )
    .run(newRecordId(), row.record_id, payload, at)
  return true
}
