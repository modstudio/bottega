// concern: keyed task-flow read-through
/** Decides and applies the optional hosted cache refresh before keyed cursor selection. */
import type { Database } from 'bun:sqlite'
import { resolveRecordApiUrl } from '../../../shared/record-api-url.ts'
import { RECORD_SIGN_IN_REMEDY } from '../../../shared/record-remedies.ts'
import { writeTransaction } from '../database/db.ts'
import { RecordApiRequestError, recordApiClient } from '../record/record-api-client.ts'
import { RECORD_TASK_FLOW_NOT_FOUND_MESSAGE } from '../record/record-task-flow.ts'
import type { HostedTaskFlow } from '../record/record-task-flow-contract.ts'
import { insertWorkflowCursorRow } from './task-flow.ts'
import {
  decideTaskFlowReadStatus,
  decideTaskFlowReadThrough,
  type TaskFlowReadStatus,
} from './task-flow-decision.ts'

export type { TaskFlowReadStatus } from './task-flow-decision.ts'

export function cacheHostedTaskFlow(
  database: Database,
  taskKey: string,
  hosted: HostedTaskFlow,
): void {
  const { flow, stage } = hosted
  writeTransaction(() => {
    database
      .query(
        `INSERT INTO task_flow
       (record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,created_at,updated_at,
        opening_machine_id,updated_machine_id,revision)
       VALUES (?,?,?,?,NULL,?,?,?,?,?)
       ON CONFLICT(task_record_id) DO UPDATE SET record_id=excluded.record_id,
         project_record_id=excluded.project_record_id,state=excluded.state,
         open_stage_cursor_record_id=NULL,updated_at=excluded.updated_at,
         opening_machine_id=excluded.opening_machine_id,updated_machine_id=excluded.updated_machine_id,
         revision=excluded.revision`,
      )
      .run(
        flow.id,
        flow.taskId,
        flow.projectId,
        flow.state,
        flow.createdAt,
        flow.updatedAt,
        flow.openingMachineId,
        flow.updatedMachineId,
        flow.revision,
      )
    if (stage) {
      const project = database
        .query<{ name: string }, [string]>('SELECT name FROM project WHERE record_id=?')
        .get(flow.projectId)!
      insertWorkflowCursorRow(
        database,
        {
          recordId: stage.id,
          projectRecordId: flow.projectId,
          project: project.name,
          workflow: stage.workflow,
          mode: stage.mode,
          workflowKey: taskKey,
          taskRecordId: flow.taskId,
          taskFlowRecordId: flow.id,
          instanceId: '',
          sessionId: null,
          workflowVersionRecordId: stage.workflowVersionId,
          catalogueVersionRecordId: stage.catalogueVersionId,
          args: JSON.stringify(stage.arguments),
          autonomy: null,
          ordinal: stage.activeOrdinal,
          stepSlug: stage.activeSlug,
          state: stage.state,
          closed: JSON.stringify(stage.closedStepNotes),
          question: null,
          totalSteps: stage.totalSteps,
          createdAt: stage.createdAt,
          updatedAt: stage.updatedAt,
          enforcement: 'floors',
          openedMachineId: stage.openedMachineId,
          takenOverFromMachineId: stage.takenOverFromMachineId,
          lastAdvancedMachineId: stage.lastAdvancedMachineId,
          revision: stage.revision,
        },
        'hosted-record',
      )
      database
        .query('UPDATE task_flow SET open_stage_cursor_record_id=? WHERE record_id=?')
        .run(stage.id, flow.id)
    }
  }, database)
}

export async function readThroughTaskFlow(
  database: Database,
  input: { taskKey: string; taskRecordId: string },
): Promise<TaskFlowReadStatus> {
  const configured = Boolean(resolveRecordApiUrl(process.env))
  try {
    const hosted = await recordApiClient().readTaskFlow!({ taskKey: input.taskKey })
    const local = database
      .query<{ revision: number | null }, [string]>(
        `SELECT cursor.revision FROM task_flow flow LEFT JOIN workflow_cursor cursor
       ON cursor.record_id=flow.open_stage_cursor_record_id WHERE flow.task_record_id=?`,
      )
      .get(input.taskRecordId)
    const decision = decideTaskFlowReadThrough({
      localFlowExists: Boolean(local),
      localStageRevision: local?.revision ?? null,
      hostedStageRevision: hosted.stage?.revision ?? null,
    })
    if (decision !== 'local') cacheHostedTaskFlow(database, input.taskKey, hosted)
    return { status: 'reachable', ...(hosted.stage ? { holder: hosted.stage.holder } : {}) }
  } catch (error) {
    if (!(error instanceof RecordApiRequestError)) throw error
    return decideTaskFlowReadStatus({
      status: error.status,
      recognizedNotFound:
        error.status === 404 && error.message === RECORD_TASK_FLOW_NOT_FOUND_MESSAGE,
      configured,
      errorRemedy: configured
        ? error.message
        : `hosted record is not configured; ${RECORD_SIGN_IN_REMEDY}`,
    })
  }
}
