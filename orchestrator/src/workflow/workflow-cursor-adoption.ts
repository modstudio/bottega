// concern: workflow cursor task adoption
/** Atomically adopts a task key and republishes every cursor-bound question. */
import type { Database } from 'bun:sqlite'
import { nowIso, writeTransaction } from '../database/db.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import { machineId } from '../record/machine-identity.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import { writeHostedTaskFlow } from '../record/record-task-flow-write-client.ts'
import { enqueueQuestionRecord } from '../run/question-outbox.ts'
import {
  attachTaskFlowStage,
  cacheAdoptedTaskFlow,
  selectTaskFlowStage,
  vacateRetiredWorkflowKeySlot,
} from './task-flow.ts'
import { resolveTaskFlowDestination } from './task-flow-hosted-destination.ts'

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
  d.query(
    "UPDATE workflow_cursor SET workflow_key=?,task_record_id=?,instance_id='',args=?,updated_at=? WHERE record_id=?",
  ).run(key, taskRecordId, JSON.stringify(adoptedArgs), nowIso(), row.record_id)
  row.workflow_key = key
  row.task_record_id = taskRecordId
  row.args = JSON.stringify(adoptedArgs)
  const questions = d
    .query<{ record_id: string }, [string]>(
      'SELECT record_id FROM question WHERE workflow_cursor_record_id=? ORDER BY number',
    )
    .all(row.record_id)
  for (const question of questions) {
    d.query(
      'UPDATE question SET workflow_key=?,workflow_task_record_id=?,revision=revision+1 WHERE record_id=?',
    ).run(key, taskRecordId, question.record_id)
    enqueueQuestionRecord(d, question.record_id)
  }
}

export async function adoptWorkflowTask(
  row: AdoptionCursor,
  suppliedTask: string | undefined,
  taskRecordId: string | null | undefined,
  d: Database,
  client?: RecordTaskFlowClient,
  statusCategory?: string | null,
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
  const conflict = d
    .query<{ id: number }, [string, string, string, string]>(
      `SELECT number id FROM workflow_cursor
       WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
         AND workflow_slug=? AND mode_slug=? AND workflow_key=?
         AND state NOT IN ('done','abandoned') LIMIT 1`,
    )
    .get(row.project, row.workflow_slug, row.mode_slug, key)
  if (conflict)
    throw new Error(
      `cursor ${row.id} cannot adopt ${key}; open cursor ${conflict.id} already holds it`,
    )
  const adoptedTaskId = taskRecordId ?? null
  if (adoptedTaskId) {
    const at = nowIso()
    const destination = await resolveTaskFlowDestination(row.project, d, client)
    const adopted = await writeHostedTaskFlow(
      'adopt',
      {
        requestId: taskFlowRequestId('adopt', [row.record_id, String(row.revision)]),
        stage: { id: row.record_id, expectedRevision: row.revision },
        taskId: adoptedTaskId,
        updatedMachineId: machineId(),
        updatedAt: at,
      },
      destination,
      client,
    )
    let stageRevision = adopted?.revisions[row.record_id] ?? row.revision
    if (adopted) {
      const adoptedArgs = { ...(JSON.parse(row.args) as Record<string, string>), key }
      const updated = await writeHostedTaskFlow(
        'stage-update',
        {
          requestId: taskFlowRequestId('stage-update', [row.record_id, String(stageRevision)]),
          stages: [
            {
              id: row.record_id,
              expectedRevision: stageRevision,
              values: { workflowKey: key, arguments: adoptedArgs, updatedAt: at },
            },
          ],
        },
        destination,
        client,
      )
      stageRevision = updated?.revisions[row.record_id] ?? stageRevision
    }
    writeTransaction(() => {
      const current = d
        .query<{ revision: number }, [string]>('SELECT revision FROM workflow_cursor WHERE record_id=?')
        .get(row.record_id)
      if (!current || current.revision !== row.revision)
        throw new Error(`workflow cursor ${row.id} changed while adopting ${key}; rerun the command`)
      assignWorkflowTaskKey(row, key, adoptedTaskId, d)
      if (adopted)
        cacheAdoptedTaskFlow(
        {
          project: row.project,
          taskRecordId: adoptedTaskId,
          cursorRecordId: row.record_id,
          flowRecordId: adopted.flowRecordId,
          flowRevision: adopted.revisions[adopted.flowRecordId]!,
          stageRevision,
          statusCategory,
          at,
        },
        d,
      )
      else {
        const flow = selectTaskFlowStage(
      {
        project: row.project,
        taskRecordId: adoptedTaskId,
        taskKey: key,
        cursor: row.id,
        workflow: row.workflow_slug,
        mode: row.mode_slug,
      },
      d,
    )
        attachTaskFlowStage(flow.flowRecordId, row.record_id, d)
      }
    }, d)
    return
  }
  assignWorkflowTaskKey(row, key, null, d)
}
