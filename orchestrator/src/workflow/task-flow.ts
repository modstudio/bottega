// concern: task flow persistence
/** Projects task state and owns the one-open-stage relationship around workflow cursors. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { machineId } from '../record/machine-identity.ts'
import {
  decideTaskStageSelection,
  type OpenTaskStage,
  taskFlowState,
} from './task-flow-decision.ts'
import { taskFlowLocalStore, taskFlowReadStore } from './task-flow-store.ts'
import type { TaskFlowStageCursorRow, WorkflowCursorInsert } from './task-flow-store-types.ts'

export function vacateRetiredWorkflowKeySlot(
  project: string,
  workflow: string,
  mode: string,
  key: string,
  d: Database,
  exceptRecordId: string | null = null,
): void {
  taskFlowLocalStore(d).retireStageIdentity({ project, workflow, mode, key, exceptRecordId })
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
      const local = taskFlowLocalStore(database).conflictingHostedStage({
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
  return taskFlowLocalStore(database).insertStage(row, conflict)
}

/** Reads the open cursor projected by a task flow without creating or changing either row. */
function openTaskFlowStageCursor(taskRecordId: string, d: Database): TaskFlowStageCursorRow | null {
  return taskFlowLocalStore(d).openStageForTask(taskRecordId)
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
  const store = taskFlowLocalStore(d)
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

function openStageFromCursor(
  cursor: TaskFlowStageCursorRow | null,
): (OpenTaskStage & { recordId: string }) | null {
  return cursor
    ? {
        cursor: cursor.id,
        workflow: cursor.workflow_slug,
        mode: cursor.mode_slug,
        recordId: cursor.record_id,
      }
    : null
}

function openStage(
  taskRecordId: string,
  d: Database,
): (OpenTaskStage & { recordId: string }) | null {
  return openStageFromCursor(openTaskFlowStageCursor(taskRecordId, d))
}

type TaskFlowStageConflictInput = {
  taskRecordId: string
  taskKey: string
  cursor?: number
  workflow: string
  mode: string
}

function taskFlowStageConflictRefusal(
  input: TaskFlowStageConflictInput,
  stage: OpenTaskStage,
): string {
  return `task ${input.taskKey} already has open stage cursor ${stage.cursor} ${stage.workflow} ${stage.mode}; finish it with ${PLATFORM_SLUG} workflow next ${stage.workflow} --cursor ${stage.cursor}, or drop it with ${PLATFORM_SLUG} workflow abandon ${stage.workflow} --cursor ${stage.cursor}`
}

function refuseTaskFlowStageConflictWithFacts(
  input: TaskFlowStageConflictInput,
  flow: object | null,
  stage: (OpenTaskStage & { recordId: string }) | null,
): void {
  if (!flow) return
  const decision = decideTaskStageSelection(stage, input)
  if (decision.action === 'refuse')
    throw new Error(taskFlowStageConflictRefusal(input, decision.stage))
}

export function refuseTaskFlowStageConflictLocal(
  input: TaskFlowStageConflictInput,
  d: Database,
): void {
  const flow = taskFlowLocalStore(d).flowProjectionForTask(input.taskRecordId)
  refuseTaskFlowStageConflictWithFacts(input, flow, openStage(input.taskRecordId, d))
}

export async function refuseTaskFlowStageConflict(
  input: TaskFlowStageConflictInput,
  d: Database,
): Promise<void> {
  const store = taskFlowReadStore(d)
  const [flow, cursor] = await Promise.all([
    store.flowProjectionForTask(input.taskRecordId),
    store.openStageForTask(input.taskRecordId),
  ])
  refuseTaskFlowStageConflictWithFacts(input, flow, openStageFromCursor(cursor))
}
