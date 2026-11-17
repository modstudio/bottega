// concern: task flow persistence
/** Projects task state and owns the one-open-stage relationship around workflow cursors. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import { decideTaskStageSelection, type OpenTaskStage } from './task-flow-decision.ts'
import { taskFlowLocalStore, taskFlowReadStore } from './task-flow-store.ts'
import { sqliteTaskFlowLocalStore } from './task-flow-store-sqlite.ts'
import type { TaskFlowStageCursorRow } from './task-flow-store-types.ts'
import { workflowCursorReference } from './workflow-cursor-format.ts'

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

/** Reads the open cursor projected by a task flow without creating or changing either row. */
function openTaskFlowStageCursor(taskRecordId: string, d: Database): TaskFlowStageCursorRow | null {
  return sqliteTaskFlowLocalStore(d).openStageForTask(taskRecordId)
}

function openStageFromCursor(
  cursor: TaskFlowStageCursorRow | null,
): (OpenTaskStage & { recordId: string }) | null {
  return cursor
    ? {
        cursor: cursor.id,
        project: cursor.project,
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
  const reference = workflowCursorReference(stage.cursor, stage.project).cli
  return `task ${input.taskKey} already has open stage cursor ${stage.cursor} ${stage.workflow} ${stage.mode}; finish it with ${PLATFORM_SLUG} workflow next ${stage.workflow}${reference}, or drop it with ${PLATFORM_SLUG} workflow abandon ${stage.workflow}${reference}`
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
  const flow = sqliteTaskFlowLocalStore(d).flowProjectionForTask(input.taskRecordId)
  refuseTaskFlowStageConflictWithFacts(input, flow, openStage(input.taskRecordId, d))
}

export async function refuseTaskFlowStageConflict(
  input: TaskFlowStageConflictInput,
  d: Database,
  client?: RecordTaskFlowClient,
): Promise<void> {
  const store = taskFlowReadStore(d, client)
  const [flow, cursor] = await Promise.all([
    store.flowProjectionForTask(input.taskRecordId),
    store.openStageForTask(input.taskRecordId),
  ])
  refuseTaskFlowStageConflictWithFacts(input, flow, openStageFromCursor(cursor))
}
