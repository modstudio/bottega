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
import {
  findWorkflowCursor,
  readThroughWorkflowCursorContext,
  resolveWorkflowCursorMode,
  type SelectableCursorRow,
  type WorkflowCursorContext,
} from './workflow-cursor-selection.ts'
import { refuseTerminalCursor } from './workflow-cursor-result.ts'

export async function linkWorkflowTaskLabel(
  database: Database,
  input: { project: string; workflowKey: string; taskRecordId: string },
  client?: RecordTaskFlowClient,
): Promise<{ workflow_cursor: number; question: number }> {
  const rows = database
    .query<{ record_id: string; revision: number; updated_at: string }, [string, string]>(
      `SELECT record_id,revision,updated_at FROM workflow_cursor
       WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
         AND workflow_key=? AND task_record_id IS NULL ORDER BY record_id`,
    )
    .all(input.project, input.workflowKey)
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
      const current = database
        .query<{ revision: number }, [string]>(
          'SELECT revision FROM workflow_cursor WHERE record_id=?',
        )
        .get(row.record_id)
      if (!current || current.revision !== row.revision)
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
    const cursors = database
      .query(
        `UPDATE workflow_cursor SET task_record_id=?
         WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
           AND workflow_key=? AND task_record_id IS NULL`,
      )
      .run(input.taskRecordId, input.project, input.workflowKey).changes
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
  if (local) refuseTerminalCursor(local)
  await readThroughWorkflowCursorContext(project, context, database)
  await linkResolvedWorkflowTask(project, context, database)
  return mode
}
