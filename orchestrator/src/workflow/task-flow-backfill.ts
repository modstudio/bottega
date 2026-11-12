// concern: task-flow-backfill
/** Enqueues complete local task-flow rows for the hosted record without changing local workflow state. */

import type { Database } from 'bun:sqlite'
import { v5 } from 'uuid'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { nowIso } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import { insertOutboxRow } from '../record/outbox-enqueue.ts'
import { stringifyOutboxPayload } from '../record/outbox-sanitize.ts'

const LEGACY_TASKLESS_FLOW_NAMESPACE = v5.URL

type FlowRow = {
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

type StageRow = {
  record_id: string
  project_record_id: string
  project_name: string
  task_flow_record_id: string | null
  workflow_slug: string
  mode_slug: string
  workflow_key: string
  instance_id: string
  session_id: string | null
  workflow_version_record_id: string
  catalogue_version_record_id: string
  args: string
  ordinal: number
  step_slug: string
  state: string
  closed: string
  question: string | null
  autonomy: string | null
  enforcement: string
  total_steps: number
  opened_machine_id: string
  taken_over_from_machine_id: string | null
  last_advanced_machine_id: string
  revision: number
  created_at: string
  updated_at: string
}

export type TaskFlowBackfillResult = { enqueuedFlows: number; enqueuedStages: number }
export type TaskFlowBackfillInspection = { flows: number; stages: number }

export function legacyTasklessFlowRecordId(stageRecordId: string): string {
  return v5(JSON.stringify(['legacy-taskless-flow', stageRecordId]), LEGACY_TASKLESS_FLOW_NAMESPACE)
}

function hasOutbox(database: Database, kind: string, rowId: string): boolean {
  return Boolean(
    database
      .query<{ id: number }, [string, string]>(
        'SELECT id FROM outbox WHERE kind=? AND row_id=? LIMIT 1',
      )
      .get(kind, rowId),
  )
}

function enqueue(
  database: Database,
  kind: 'task_flow' | 'task_flow_stage',
  rowId: string,
  payload: Record<string, unknown>,
): void {
  insertOutboxRow(database, {
    recordId: newRecordId(),
    kind,
    rowId,
    payload: stringifyOutboxPayload(kind, payload),
    createdAt: nowIso(),
  })
}

function flowPayload(row: FlowRow): Record<string, unknown> {
  return {
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
  }
}

function tasklessFlowPayload(row: StageRow, id: string): Record<string, unknown> {
  const open = row.state === 'running' || row.state === 'awaiting-ruling'
  return {
    id,
    spaceId: PLATFORM_SPACE_ID,
    projectId: row.project_record_id,
    projectName: row.project_name,
    taskId: null,
    state: open ? 'open' : row.state === 'done' ? 'done' : 'dropped',
    openStageRecordId: open ? row.record_id : null,
    openingMachineId: row.opened_machine_id,
    updatedMachineId: row.last_advanced_machine_id,
    machineId: machineId(),
    revision: 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function stagePayload(row: StageRow, flowRecordId: string): Record<string, unknown> {
  return {
    id: row.record_id,
    spaceId: PLATFORM_SPACE_ID,
    projectId: row.project_record_id,
    projectName: row.project_name,
    flowRecordId,
    workflow: row.workflow_slug,
    mode: row.mode_slug,
    workflowKey: row.workflow_key,
    instanceId: row.instance_id,
    sessionId: row.session_id,
    workflowVersionId: row.workflow_version_record_id,
    catalogueVersionId: row.catalogue_version_record_id,
    arguments: JSON.parse(row.args),
    activeOrdinal: row.ordinal,
    activeSlug: row.step_slug,
    state: row.state,
    closedStepNotes: JSON.parse(row.closed),
    question: row.question,
    autonomy: row.autonomy,
    enforcement: row.enforcement,
    totalSteps: row.total_steps,
    openedMachineId: row.opened_machine_id,
    takenOverFromMachineId: row.taken_over_from_machine_id,
    lastAdvancedMachineId: row.last_advanced_machine_id,
    machineId: machineId(),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function localFlows(database: Database): FlowRow[] {
  return database
    .query<FlowRow, []>(
      `SELECT flow.*,project.name project_name FROM task_flow flow
       JOIN project ON project.record_id=flow.project_record_id ORDER BY flow.record_id`,
    )
    .all()
}

function localStages(database: Database): StageRow[] {
  return database
    .query<StageRow, []>(
      `SELECT cursor.*,project.name project_name FROM workflow_cursor cursor
       JOIN project ON project.record_id=cursor.project_record_id ORDER BY cursor.record_id`,
    )
    .all()
}

export function inspectTaskFlowBackfill(database: Database): TaskFlowBackfillInspection {
  return {
    flows: database
      .query<{ count: number }, []>(
        `SELECT count(*) count FROM task_flow flow WHERE NOT EXISTS
         (SELECT 1 FROM outbox WHERE kind='task_flow' AND row_id=flow.record_id)`,
      )
      .get()!.count,
    stages: database
      .query<{ count: number }, []>(
        `SELECT count(*) count FROM workflow_cursor cursor WHERE NOT EXISTS
         (SELECT 1 FROM outbox WHERE kind='task_flow_stage' AND row_id=cursor.record_id)`,
      )
      .get()!.count,
  }
}

export function backfillTaskFlowRecords(database: Database): TaskFlowBackfillResult {
  let enqueuedFlows = 0
  let enqueuedStages = 0
  for (const row of localFlows(database)) {
    if (hasOutbox(database, 'task_flow', row.record_id)) continue
    enqueue(database, 'task_flow', row.record_id, flowPayload(row))
    enqueuedFlows++
  }
  for (const row of localStages(database)) {
    if (hasOutbox(database, 'task_flow_stage', row.record_id)) continue
    const flowRecordId = row.task_flow_record_id ?? legacyTasklessFlowRecordId(row.record_id)
    if (!row.task_flow_record_id && !hasOutbox(database, 'task_flow', flowRecordId)) {
      enqueue(database, 'task_flow', flowRecordId, tasklessFlowPayload(row, flowRecordId))
      enqueuedFlows++
    }
    enqueue(database, 'task_flow_stage', row.record_id, stagePayload(row, flowRecordId))
    enqueuedStages++
  }
  return { enqueuedFlows, enqueuedStages }
}
