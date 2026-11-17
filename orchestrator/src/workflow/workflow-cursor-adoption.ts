// concern: workflow cursor task adoption
/** Atomically adopts a task key and republishes every cursor-bound question. */
import type { Database } from 'bun:sqlite'
import { nowIso, writeTransaction } from '../database/db.ts'
import {
  mutateQuestion,
  requireQuestionMutationApplied,
} from '../question-store/question-store-mutation.ts'
import { questionsForWorkflowCursor } from '../question-store/question-store-read.ts'
import { machineId } from '../record/machine-identity.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import {
  taskFlowWriteTarget,
  writeHostedTaskFlow,
} from '../record/record-task-flow-write-client.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import { refuseTaskFlowStageConflictLocal, vacateRetiredWorkflowKeySlot } from './task-flow.ts'
import { taskFlowLocalStore, taskFlowReadStore } from './task-flow-store.ts'

type AdoptionCursor = {
  id: number
  record_id: string
  project: string
  workflow_slug: string
  mode_slug: string
  workflow_key: string
  task_record_id: string | null
  args: string
  revision: number
}

function assignWorkflowTaskKey(
  row: AdoptionCursor,
  key: string,
  taskRecordId: string | null,
  d: Database,
): void {
  vacateRetiredWorkflowKeySlot(row.project, row.workflow_slug, row.mode_slug, key, d)
  const adoptedArgs = { ...(JSON.parse(row.args) as Record<string, string>), key }
  row.workflow_key = key
  row.task_record_id = taskRecordId
  row.args = JSON.stringify(adoptedArgs)
}

async function linkCursorQuestions(
  d: Database,
  cursorId: string,
  workflowKey: string,
  workflowTaskId: string | null,
  at: string,
): Promise<void> {
  for (const question of await questionsForWorkflowCursor(d, cursorId)) {
    const mutation = await mutateQuestion(d, {
      id: String(question.record_id),
      intent: 'link',
      at,
      actorSession: null,
      reason: null,
      expectedRevision: Number(question.revision),
      changes: { workflowKey, workflowTaskId },
    })
    requireQuestionMutationApplied(mutation, question)
  }
}

export async function adoptWorkflowTask(
  row: AdoptionCursor,
  suppliedTask: string | undefined,
  taskRecordId: string | null | undefined,
  d: Database,
  client?: RecordTaskFlowClient,
  _statusCategory?: string | null,
): Promise<void> {
  const key = suppliedTask?.trim()
  if (!key) return
  if (row.workflow_key) {
    if (row.workflow_key !== key)
      throw new Error(
        `cursor ${row.id} is already assigned to ${row.workflow_key}; it cannot adopt ${key}`,
      )
    return
  }
  const conflict = await conflictingAdoptionCursor(row, key, d, client)
  if (conflict)
    throw new Error(
      `cursor ${row.id} cannot adopt ${key}; open cursor ${conflict.id} already holds it`,
    )
  const adoptedTaskId = taskRecordId ?? null
  if (adoptedTaskId) {
    const at = nowIso()
    const target = taskFlowWriteTarget(row.project, d)
    const adoptPayload = {
      requestId: taskFlowRequestId('adopt', [row.record_id, String(row.revision)]),
      stage: { id: row.record_id, expectedRevision: row.revision },
      stageValues: {
        workflowKey: key,
        arguments: { ...(JSON.parse(row.args) as Record<string, string>), key },
      },
      taskId: adoptedTaskId,
      updatedMachineId: machineId(),
      updatedAt: at,
    }
    const adopted = await writeHostedTaskFlow('adopt', adoptPayload, target, client)
    writeTransaction(() => {
      if (!adopted)
        refuseTaskFlowStageConflictLocal(
          {
            taskRecordId: adoptedTaskId,
            taskKey: key,
            cursor: row.id,
            workflow: row.workflow_slug,
            mode: row.mode_slug,
          },
          d,
        )
      const store = taskFlowLocalStore(d)
      const result = store.write('adopt', adoptPayload, adopted)
      row.revision = result.revisions[row.record_id]!
      assignWorkflowTaskKey(row, key, adoptedTaskId, d)
    }, d)
    await linkCursorQuestions(d, row.record_id, key, adoptedTaskId, at)
    return
  }
  const at = nowIso()
  const payload = {
    requestId: taskFlowRequestId('stage-update', [row.record_id, String(row.revision)]),
    stages: [
      {
        id: row.record_id,
        expectedRevision: row.revision,
        values: {
          workflowKey: key,
          arguments: { ...(JSON.parse(row.args) as Record<string, string>), key },
          updatedAt: at,
        },
      },
    ],
  }
  const updated = await writeHostedTaskFlow(
    'stage-update',
    payload,
    taskFlowWriteTarget(row.project, d),
    client,
  )
  writeTransaction(() => {
    const result = taskFlowLocalStore(d).write('stage-update', payload, updated)
    row.revision = result.revisions[row.record_id]!
    assignWorkflowTaskKey(row, key, null, d)
  }, d)
  await linkCursorQuestions(d, row.record_id, key, null, at)
}

async function conflictingAdoptionCursor(
  row: AdoptionCursor,
  key: string,
  database: Database,
  client?: RecordTaskFlowClient,
): Promise<{ id: number } | null> {
  return taskFlowReadStore(database, client).stageHoldingTaskKey({
    project: row.project,
    workflow: row.workflow_slug,
    mode: row.mode_slug,
    key,
  })
}
