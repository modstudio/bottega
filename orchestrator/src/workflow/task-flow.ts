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
import { taskFlowStore } from './task-flow-store.ts'
import type {
  TaskFlowProjectionRow,
  TaskFlowStageCursorRow,
  WorkflowCursorInsert,
} from './task-flow-store-types.ts'

export function vacateRetiredWorkflowKeySlot(
  project: string,
  workflow: string,
  mode: string,
  key: string,
  d: Database,
  exceptRecordId: string | null = null,
): void {
  taskFlowStore(d).retireStageIdentity({ project, workflow, mode, key, exceptRecordId })
}

/** Owns the complete persisted workflow-cursor row shape for local and hosted inserts. */
export function insertWorkflowCursorRow(
  database: Database,
  row: WorkflowCursorInsert,
  conflict: 'local-identity' | 'hosted-record',
): string {
  const projectRecordId = row.projectRecordId
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
      const local = taskFlowStore(database).conflictingHostedStage({
        projectRecordId,
        workflow: row.workflow,
        mode: row.mode,
        key: row.workflowKey,
        recordId: row.recordId,
      })
      if (local)
        throw new Error(
          `local cursor ${local.number} (${local.record_id}) conflicts with hosted stage ${row.recordId}; abandon it with ${PLATFORM_SLUG} workflow abandon --cursor ${local.number} --reason "<text>"`,
        )
    }
  }
  return taskFlowStore(database).insertStage(row, conflict)
}

/** Reads the open cursor projected by a task flow without creating or changing either row. */
export function openTaskFlowStageCursor(
  taskRecordId: string,
  d: Database,
): TaskFlowStageCursorRow | null {
  return taskFlowStore(d).openStageForTask(taskRecordId)
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
  const store = taskFlowStore(d)
  const existing = store.flowRecordIdForTask(input.taskRecordId)
  if (existing && existing !== input.flowRecordId)
    throw new Error(
      `task flow ${existing} disagrees with hosted flow ${input.flowRecordId}; rerun after refreshing the hosted task flow`,
    )
  const machine = machineId()
  store.cacheAdoptedFlow({
    ...input,
    state: taskFlowState(input.statusCategory),
    machineId: machine,
  })
}

function projectTaskFlow(
  project: string,
  taskRecordId: string,
  statusCategory: string | null | undefined,
  d: Database,
): TaskFlowProjectionRow {
  const at = nowIso()
  const state = taskFlowState(statusCategory)
  const machine = machineId()
  return taskFlowStore(d).projectFlow({
    recordId: newRecordId(),
    project,
    taskRecordId,
    state,
    at,
    machineId: machine,
  })
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
  const flow = taskFlowStore(d).flowProjectionForTask(input.taskRecordId)
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

