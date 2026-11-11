// concern: workflows
/** Owns project-scoped linking of a workflow label to its durable task identity. */

import type { Database } from 'bun:sqlite'
import { writableDb, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import {
  taskFlowWriteTarget,
  writeHostedTaskFlow,
} from '../record/record-task-flow-write-client.ts'
import type { TaskFlowAdoptResult } from '../record/record-task-flow-write-contract.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import { linkWorkflowQuestionsTaskReference } from '../run/question-mutation.ts'
import { cacheAdoptedTaskFlow } from './task-flow.ts'
import { taskFlowStore } from './task-flow-store.ts'
import { cursorName } from './workflow-cursor-format.ts'
import {
  findWorkflowCursor,
  readThroughWorkflowCursorContext,
  resolveWorkflowCursorMode,
  type SelectableCursorRow,
  type WorkflowCursorContext,
} from './workflow-cursor-selection.ts'
import { decideCursorStart } from './workflow-cursor-transition.ts'

export async function linkWorkflowTaskLabel(
  database: Database,
  input: { project: string; workflowKey: string; taskRecordId: string },
  client?: RecordTaskFlowClient,
): Promise<{ workflow_cursor: number; question: number }> {
  const store = taskFlowStore(database)
  const rows = store.stagesNeedingTaskLink(input.project, input.workflowKey)
  const hosted = [] as Array<{
    row: (typeof rows)[number]
    result: TaskFlowAdoptResult
  }>
  const target = taskFlowWriteTarget(input.project, database)
  for (const row of rows) {
    const result = await writeHostedTaskFlow(
      'adopt',
      {
        requestId: taskFlowRequestId('adopt', [row.record_id, String(row.revision)]),
        stage: { id: row.record_id, expectedRevision: row.revision },
        taskId: input.taskRecordId,
        updatedMachineId: machineId(),
        updatedAt: row.updated_at,
      },
      target,
      client,
    )
    if (result) hosted.push({ row, result })
  }
  return writeTransaction(() => {
    for (const { row, result } of hosted) {
      const currentRevision = store.stageRevision(row.record_id)
      if (currentRevision !== row.revision)
        throw new Error(
          `workflow cursor ${row.record_id} changed while its task was linked; rerun the command`,
        )
      cacheAdoptedTaskFlow(
        {
          project: input.project,
          taskRecordId: input.taskRecordId,
          cursorRecordId: row.record_id,
          flowRecordId: result.flowRecordId,
          flowRevision: result.revisions[result.flowRecordId]!,
          stageRevision: result.revisions[row.record_id]!,
          at: row.updated_at,
        },
        database,
      )
    }
    const cursors = store.linkUnhostedStagesToTask(input)
    const questions = linkWorkflowQuestionsTaskReference(input, database)
    return { workflow_cursor: cursors + hosted.length, question: questions }
  }, database)
}

export async function linkResolvedWorkflowTask(
  project: string,
  context: WorkflowCursorContext,
  database: Database,
): Promise<void> {
  const workflowKey = context.workflowKey
  if (!workflowKey || !context.taskRecordId) return
  await linkWorkflowTaskLabel(
    database,
    { project, workflowKey, taskRecordId: context.taskRecordId },
    context.taskFlowClient,
  )
}

export async function withLinkedWorkflowTask<T>(
  project: string,
  context: WorkflowCursorContext,
  database: Database,
  action: () => T | Promise<T>,
): Promise<T> {
  await linkResolvedWorkflowTask(project, context, database)
  return action()
}

/** Resolves a mode after applying the one-key rollout link in the cursor transaction. */
export async function resolveLinkedWorkflowCursorMode(
  slug: string,
  project: string,
  requested: string | undefined,
  args: Record<string, string>,
  context: WorkflowCursorContext,
  caller: string,
  remedy: string,
  database: Database = writableDb(),
  selectedRow?: SelectableCursorRow,
): Promise<string> {
  const mode = resolveWorkflowCursorMode(
    slug,
    project,
    requested,
    args,
    context,
    caller,
    remedy,
    database,
    selectedRow,
  )
  const local = selectedRow ?? findWorkflowCursor(project, slug, mode, args, context, database)
  if (local && decideCursorStart(local.state) === 'retire')
    throw new Error(
      `${cursorName(local.workflow_slug, local.mode_slug, local.workflow_key)} is ${local.state}`,
    )
  await readThroughWorkflowCursorContext(project, context, database)
  await linkResolvedWorkflowTask(project, context, database)
  return mode
}
