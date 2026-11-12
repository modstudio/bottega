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
import type {
  TaskFlowAdoptResult,
  TaskFlowIntentInput,
} from '../record/record-task-flow-write-contract.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import { linkWorkflowQuestionsTaskReference } from '../run/question-mutation.ts'
import { taskFlowLocalStore, taskFlowReadStore } from './task-flow-store.ts'
import { decideAppliedMirrorMutation } from './task-flow-store-sqlite-write.ts'
import { readThroughTaskFlow } from './task-flow-read-through.ts'
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
  const rows = await taskFlowReadStore(database).stagesNeedingTaskLink(
    input.project,
    input.workflowKey,
  )
  const hosted = [] as Array<{
    row: (typeof rows)[number]
    payload: TaskFlowIntentInput<'adopt'>
    result: TaskFlowAdoptResult | null
  }>
  const target = taskFlowWriteTarget(input.project, database)
  for (const row of rows) {
    const payload = {
      requestId: taskFlowRequestId('adopt', [row.record_id, String(row.revision)]),
      stage: { id: row.record_id, expectedRevision: row.revision },
      taskId: input.taskRecordId,
      updatedMachineId: machineId(),
      updatedAt: row.updated_at,
    }
    const result = await writeHostedTaskFlow('adopt', payload, target, client)
    hosted.push({ row, payload, result })
  }
  const store = taskFlowLocalStore(database)
  const refresh = hosted.filter(({ payload, result }) => {
    if (!result) return false
    const local = database
      .query<{ revision: number }, [string]>('SELECT revision FROM workflow_cursor WHERE record_id=?')
      .get(payload.stage.id)?.revision ?? null
    return (
      decideAppliedMirrorMutation(
        local,
        payload.stage.expectedRevision,
        result.revisions[payload.stage.id],
      ) === 'refresh'
    )
  })
  const linked = writeTransaction(() => {
    for (const { payload, result } of hosted)
      if (!refresh.some(({ payload: skipped }) => skipped.stage.id === payload.stage.id))
        store.write('adopt', payload, result)
    const cursors = 0
    const questions = linkWorkflowQuestionsTaskReference(input, database)
    return { workflow_cursor: cursors + hosted.length, question: questions }
  }, database)
  for (const { result } of refresh)
    if (result)
      await readThroughTaskFlow(database, {
        project: input.project,
        taskKey: input.workflowKey,
        taskRecordId: input.taskRecordId,
      })
  return linked
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
  const mode = await resolveWorkflowCursorMode(
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
  const local =
    selectedRow ?? (await findWorkflowCursor(project, slug, mode, args, context, database))
  if (local && decideCursorStart(local.state) === 'retire')
    throw new Error(
      `${cursorName(local.workflow_slug, local.mode_slug, local.workflow_key)} is ${local.state}`,
    )
  await readThroughWorkflowCursorContext(project, context, database)
  await linkResolvedWorkflowTask(project, context, database)
  return mode
}
