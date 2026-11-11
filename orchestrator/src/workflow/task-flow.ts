// concern: task flow persistence
/** Projects task state and owns the one-open-stage relationship around workflow cursors. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { nowIso } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import {
  decideTaskStageSelection,
  type OpenTaskStage,
  taskFlowState,
} from './task-flow-decision.ts'
import type { CursorState } from './workflow-cursor-transition.ts'
import type { EnforcementMode } from './workflow-floor.ts'

export type TaskFlowStageCursorRow = {
  id: number
  record_id: string
  project: string
  workflow_slug: string
  mode_slug: string
  workflow_key: string
  task_record_id: string | null
  task_flow_record_id: string | null
  instance_id: string
  session_id: string | null
  ordinal: number
  step_slug: string
  state: CursorState
  workflow_version_record_id: string
  catalogue_version_record_id: string
  workflow_version: number
  catalogue_version: number
  args: string
  autonomy: string | null
  closed: string
  question: string | null
  total_steps: number
  created_at: string
  enforcement: EnforcementMode
  opened_machine_id: string | null
  taken_over_from_machine_id: string | null
  last_advanced_machine_id: string | null
  revision: number
  updated_at: string
}

export type WorkflowCursorInsert = {
  recordId: string
  projectRecordId?: string
  project: string
  workflow: string
  mode: string
  workflowKey: string
  taskRecordId: string | null
  taskFlowRecordId: string | null
  instanceId: string
  sessionId: string | null
  workflowVersionRecordId: string
  catalogueVersionRecordId: string
  args: string
  autonomy: string | null
  ordinal: number
  stepSlug: string
  state: string
  closed: string
  question: string | null
  totalSteps: number
  createdAt: string
  updatedAt: string
  enforcement: string
  openedMachineId: string | null
  takenOverFromMachineId: string | null
  lastAdvancedMachineId: string | null
  revision: number
}

export function vacateRetiredWorkflowKeySlot(
  project: string,
  workflow: string,
  mode: string,
  key: string,
  d: Database,
  exceptRecordId: string | null = null,
): void {
  d.query(
    `UPDATE workflow_cursor SET instance_id=instance_id || '#' || number
     WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
       AND workflow_slug=? AND mode_slug=? AND workflow_key=? AND instance_id=''
       AND (? IS NULL OR record_id<>?)
       AND state IN ('done','abandoned')`,
  ).run(project, workflow, mode, key, exceptRecordId, exceptRecordId)
}

/** Owns the complete persisted workflow-cursor row shape for local and hosted inserts. */
export function insertWorkflowCursorRow(
  database: Database,
  row: WorkflowCursorInsert,
  conflict: 'local-identity' | 'hosted-record',
): string {
  const projectRecordId =
    row.projectRecordId ??
    database
      .query<{ record_id: string }, [string]>('SELECT record_id FROM project WHERE name=?')
      .get(row.project)!.record_id
  if (row.workflowKey && row.instanceId === '') {
    vacateRetiredWorkflowKeySlot(
      row.project,
      row.workflow,
      row.mode,
      row.workflowKey,
      database,
      row.recordId,
    )
    if (conflict === 'hosted-record') {
      const local = database
        .query<{ number: number; record_id: string }, [string, string, string, string, string]>(
          `SELECT number,record_id FROM workflow_cursor
           WHERE project_record_id=? AND workflow_slug=? AND mode_slug=? AND workflow_key=?
             AND instance_id='' AND state NOT IN ('done','abandoned') AND record_id<>?`,
        )
        .get(projectRecordId, row.workflow, row.mode, row.workflowKey, row.recordId)
      if (local)
        throw new Error(
          `local cursor ${local.number} (${local.record_id}) conflicts with hosted stage ${row.recordId}; abandon it with ${PLATFORM_SLUG} workflow abandon --cursor ${local.number} --reason "<text>"`,
        )
    }
  }
  const conflictSql =
    conflict === 'local-identity'
      ? `ON CONFLICT(project_record_id,workflow_slug,mode_slug,workflow_key,instance_id) DO UPDATE SET
           session_id=COALESCE(excluded.session_id,workflow_cursor.session_id),
           updated_at=excluded.updated_at`
      : ''
  return database
    .query<{ record_id: string }, (string | number | null)[]>(
      `INSERT INTO workflow_cursor
       (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,task_record_id,
        task_flow_record_id,instance_id,session_id,workflow_version_record_id,catalogue_version_record_id,
        args,autonomy,ordinal,step_slug,state,closed,question,total_steps,created_at,updated_at,enforcement,
        opened_machine_id,taken_over_from_machine_id,last_advanced_machine_id,revision)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ${conflictSql}
       RETURNING record_id`,
    )
    .get(
      row.recordId,
      row.project,
      projectRecordId,
      row.workflow,
      row.mode,
      row.workflowKey,
      row.taskRecordId,
      row.taskFlowRecordId,
      row.instanceId,
      row.sessionId,
      row.workflowVersionRecordId,
      row.catalogueVersionRecordId,
      row.args,
      row.autonomy,
      row.ordinal,
      row.stepSlug,
      row.state,
      row.closed,
      row.question,
      row.totalSteps,
      row.createdAt,
      row.updatedAt,
      row.enforcement,
      row.openedMachineId,
      row.takenOverFromMachineId,
      row.lastAdvancedMachineId,
      row.revision,
    )!.record_id
}

type TaskFlowRow = { record_id: string; open_stage_cursor_record_id: string | null }

/** Reads the open cursor projected by a task flow without creating or changing either row. */
export function openTaskFlowStageCursor(
  taskRecordId: string,
  d: Database,
): TaskFlowStageCursorRow | null {
  return d
    .query<TaskFlowStageCursorRow, [string]>(
      `SELECT cursor.number id,cursor.record_id,cursor.project,cursor.workflow_slug,cursor.mode_slug,
       cursor.workflow_key,cursor.task_record_id,cursor.task_flow_record_id,cursor.instance_id,
       cursor.session_id,cursor.ordinal,cursor.step_slug,cursor.state,cursor.workflow_version_record_id,
       cursor.catalogue_version_record_id,
       (SELECT n FROM workflow_version WHERE record_id=cursor.workflow_version_record_id) workflow_version,
       (SELECT n FROM step_catalogue_version WHERE record_id=cursor.catalogue_version_record_id) catalogue_version,
       cursor.args,cursor.autonomy,cursor.closed,cursor.question,cursor.total_steps,cursor.created_at,
       cursor.updated_at,cursor.enforcement,cursor.opened_machine_id,cursor.taken_over_from_machine_id,
       cursor.last_advanced_machine_id,cursor.revision
       FROM task_flow flow JOIN workflow_cursor cursor
       ON cursor.record_id=flow.open_stage_cursor_record_id WHERE flow.task_record_id=?`,
    )
    .get(taskRecordId)
}

export function cacheAdoptedTaskFlow(
  input: {
    project: string
    taskRecordId: string
    cursorRecordId: string
    flowRecordId: string
    flowRevision: number
    stageRevision: number
    statusCategory?: string | null
    at: string
  },
  d: Database,
): void {
  const existing = d
    .query<{ record_id: string }, [string]>(
      'SELECT record_id FROM task_flow WHERE task_record_id=?',
    )
    .get(input.taskRecordId)
  if (existing && existing.record_id !== input.flowRecordId)
    throw new Error(
      `task flow ${existing.record_id} disagrees with hosted flow ${input.flowRecordId}; rerun after refreshing the hosted task flow`,
    )
  const machine = machineId()
  d.query(
    `INSERT INTO task_flow
       (record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,
        created_at,updated_at,opening_machine_id,updated_machine_id,revision)
     VALUES (?,?,(SELECT record_id FROM project WHERE name=?),COALESCE(?,'open'),?,?,?,?,?,?)
     ON CONFLICT(task_record_id) DO UPDATE SET
       state=COALESCE(excluded.state,task_flow.state),
       open_stage_cursor_record_id=excluded.open_stage_cursor_record_id,
       updated_at=excluded.updated_at,updated_machine_id=excluded.updated_machine_id,
       revision=excluded.revision`,
  ).run(
    input.flowRecordId,
    input.taskRecordId,
    input.project,
    taskFlowState(input.statusCategory),
    input.cursorRecordId,
    input.at,
    input.at,
    machine,
    machine,
    input.flowRevision,
  )
  d.query(
    `UPDATE workflow_cursor SET task_record_id=?,task_flow_record_id=?,revision=?
     WHERE record_id=?`,
  ).run(input.taskRecordId, input.flowRecordId, input.stageRevision, input.cursorRecordId)
}

function stampTaskFlowMachine(flowRecordId: string, d: Database): void {
  const machine = machineId()
  d.query(
    `UPDATE task_flow SET opening_machine_id=COALESCE(opening_machine_id,?),
       updated_machine_id=?,revision=revision+1 WHERE record_id=?`,
  ).run(machine, machine, flowRecordId)
}

export function stampWorkflowCursorMachine(
  cursorRecordId: string,
  revisionIncrement: 0 | 1,
  d: Database,
): void {
  const machine = machineId()
  d.query(
    `UPDATE workflow_cursor SET opened_machine_id=COALESCE(opened_machine_id,?),
       last_advanced_machine_id=?,revision=revision+? WHERE record_id=?`,
  ).run(machine, machine, revisionIncrement, cursorRecordId)
}

function projectTaskFlow(
  project: string,
  taskRecordId: string,
  statusCategory: string | null | undefined,
  d: Database,
): TaskFlowRow {
  const at = nowIso()
  const state = taskFlowState(statusCategory)
  const machine = machineId()
  const flow = d
    .query<
      TaskFlowRow,
      [string, string, string, string | null, string, string, string, string, string | null]
    >(
      `INSERT INTO task_flow
         (record_id,task_record_id,project_record_id,state,created_at,updated_at,
          opening_machine_id,updated_machine_id,revision)
       VALUES (?, ?, (SELECT record_id FROM project WHERE name=?), COALESCE(?, 'open'), ?, ?, ?, ?, 1)
       ON CONFLICT(task_record_id) DO UPDATE
         SET state=COALESCE(?,task_flow.state),updated_at=excluded.updated_at,
             opening_machine_id=COALESCE(task_flow.opening_machine_id,excluded.opening_machine_id),
             updated_machine_id=excluded.updated_machine_id,revision=task_flow.revision+1
       RETURNING record_id,open_stage_cursor_record_id`,
    )
    .get(newRecordId(), taskRecordId, project, state, at, at, machine, machine, state)!
  return flow
}

function openStage(
  taskRecordId: string,
  d: Database,
): (OpenTaskStage & { recordId: string }) | null {
  const cursor = openTaskFlowStageCursor(taskRecordId, d)
  return cursor
    ? {
        cursor: cursor.id,
        workflow: cursor.workflow_slug,
        mode: cursor.mode_slug,
        recordId: cursor.record_id,
      }
    : null
}

export function refuseTaskFlowStageConflict(
  input: { taskRecordId: string; taskKey: string; cursor?: number; workflow: string; mode: string },
  d: Database,
): void {
  const flow = d
    .query<TaskFlowRow, [string]>(
      'SELECT record_id,open_stage_cursor_record_id FROM task_flow WHERE task_record_id=?',
    )
    .get(input.taskRecordId)
  if (!flow) return
  const decision = decideTaskStageSelection(openStage(input.taskRecordId, d), input)
  if (decision.action === 'refuse')
    throw new Error(
      `task ${input.taskKey} already has open stage cursor ${decision.stage.cursor} ${decision.stage.workflow} ${decision.stage.mode}; finish it with ${PLATFORM_SLUG} workflow next ${decision.stage.workflow} --cursor ${decision.stage.cursor}, or drop it with ${PLATFORM_SLUG} workflow abandon ${decision.stage.workflow} --cursor ${decision.stage.cursor}`,
    )
}

export function selectTaskFlowStage(
  input: {
    project: string
    taskRecordId: string
    taskKey: string
    statusCategory?: string | null
    cursor?: number
    workflow: string
    mode: string
  },
  d: Database,
): { flowRecordId: string; cursorRecordId: string | null } {
  refuseTaskFlowStageConflict(input, d)
  const flow = projectTaskFlow(input.project, input.taskRecordId, input.statusCategory, d)
  const stage = openStage(input.taskRecordId, d)
  const decision = decideTaskStageSelection(stage, input)
  if (decision.action === 'refuse')
    throw new Error(
      `task ${input.taskKey} already has open stage cursor ${decision.stage.cursor} ${decision.stage.workflow} ${decision.stage.mode}; finish it with ${PLATFORM_SLUG} workflow next ${decision.stage.workflow} --cursor ${decision.stage.cursor}, or drop it with ${PLATFORM_SLUG} workflow abandon ${decision.stage.workflow} --cursor ${decision.stage.cursor}`,
    )
  return {
    flowRecordId: flow.record_id,
    cursorRecordId: decision.action === 'reuse' ? stage!.recordId : null,
  }
}

export function attachTaskFlowStage(
  flowRecordId: string,
  cursorRecordId: string,
  d: Database,
): void {
  const at = nowIso()
  d.query('UPDATE workflow_cursor SET task_flow_record_id=? WHERE record_id=?').run(
    flowRecordId,
    cursorRecordId,
  )
  stampWorkflowCursorMachine(cursorRecordId, 1, d)
  d.query('UPDATE task_flow SET open_stage_cursor_record_id=?,updated_at=? WHERE record_id=?').run(
    cursorRecordId,
    at,
    flowRecordId,
  )
  stampTaskFlowMachine(flowRecordId, d)
}

export function attachInsertedTaskFlowStage(
  input: {
    project: string
    taskRecordId?: string | null
    taskKey: string
    statusCategory?: string | null
    cursor: { id: number; record_id: string; workflow_slug: string; mode_slug: string }
  },
  d: Database,
): string | null {
  if (!input.taskKey || !input.taskRecordId) return null
  const flow = selectTaskFlowStage(
    {
      project: input.project,
      taskRecordId: input.taskRecordId,
      taskKey: input.taskKey,
      statusCategory: input.statusCategory,
      cursor: input.cursor.id,
      workflow: input.cursor.workflow_slug,
      mode: input.cursor.mode_slug,
    },
    d,
  )
  attachTaskFlowStage(flow.flowRecordId, input.cursor.record_id, d)
  return flow.flowRecordId
}
