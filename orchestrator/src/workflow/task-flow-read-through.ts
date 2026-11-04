// concern: keyed task-flow read-through
/** Decides and applies the optional hosted cache refresh before keyed cursor selection. */
import type { Database } from 'bun:sqlite'
import { resolveRecordApiUrl } from '../../../shared/record-api-url.ts'
import { RECORD_SIGN_IN_REMEDY } from '../../../shared/record-remedies.ts'
import { writeTransaction } from '../database/db.ts'
import { RecordApiRequestError, recordApiClient } from '../record/record-api-client.ts'
import type { HostedTaskFlow } from '../record/record-task-flow-contract.ts'

export type TaskFlowReadDecision = 'local' | 'hosted' | 'refresh'
export function decideTaskFlowReadThrough(input: {
  localStageRevision: number | null
  hostedStageRevision: number | null
}): TaskFlowReadDecision {
  if (input.hostedStageRevision == null) return 'local'
  if (input.localStageRevision == null) return 'hosted'
  return input.hostedStageRevision > input.localStageRevision ? 'refresh' : 'local'
}

export type TaskFlowReadStatus = {
  reachable: boolean
  remedy?: string
  holder?: { id: string; displayName: string }
}

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
      database
        .query(
          `INSERT INTO workflow_cursor
         (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,task_record_id,
          task_flow_record_id,instance_id,session_id,workflow_version_record_id,catalogue_version_record_id,
          args,autonomy,ordinal,step_slug,state,closed,question,total_steps,created_at,updated_at,enforcement,
          opened_machine_id,taken_over_from_machine_id,last_advanced_machine_id,revision)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),
          (SELECT name FROM project WHERE record_id=?),?,?,?,?,?,?,'',NULL,?,?,?,NULL,?,?,?, ?,NULL,?,?,?,'floors',?,?,?,?)
         ON CONFLICT(record_id) DO UPDATE SET task_flow_record_id=excluded.task_flow_record_id,
          ordinal=excluded.ordinal,step_slug=excluded.step_slug,state=excluded.state,closed=excluded.closed,
          total_steps=excluded.total_steps,updated_at=excluded.updated_at,
          taken_over_from_machine_id=excluded.taken_over_from_machine_id,
          last_advanced_machine_id=excluded.last_advanced_machine_id,revision=excluded.revision`,
        )
        .run(
          stage.id,
          flow.projectId,
          flow.projectId,
          stage.workflow,
          stage.mode,
          taskKey,
          flow.taskId,
          flow.id,
          stage.workflowVersionId,
          stage.catalogueVersionId,
          JSON.stringify(stage.arguments),
          stage.activeOrdinal,
          stage.activeSlug,
          stage.state,
          JSON.stringify(stage.closedStepNotes),
          stage.totalSteps,
          stage.createdAt,
          stage.updatedAt,
          stage.openedMachineId,
          stage.takenOverFromMachineId,
          stage.lastAdvancedMachineId,
          stage.revision,
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
    const hosted = await recordApiClient().readTaskFlow({ taskKey: input.taskKey })
    const local = database
      .query<{ revision: number }, [string]>(
        `SELECT cursor.revision FROM task_flow flow LEFT JOIN workflow_cursor cursor
       ON cursor.record_id=flow.open_stage_cursor_record_id WHERE flow.task_record_id=?`,
      )
      .get(input.taskRecordId)
    const decision = decideTaskFlowReadThrough({
      localStageRevision: local?.revision ?? null,
      hostedStageRevision: hosted.stage?.revision ?? null,
    })
    if (decision !== 'local') cacheHostedTaskFlow(database, input.taskKey, hosted)
    return { reachable: true, ...(hosted.stage ? { holder: hosted.stage.holder } : {}) }
  } catch (error) {
    if (error instanceof RecordApiRequestError && error.status === 404) return { reachable: true }
    if (!(error instanceof RecordApiRequestError)) throw error
    return {
      reachable: false,
      remedy: configured
        ? error instanceof Error
          ? error.message
          : String(error)
        : `hosted record is not configured; ${RECORD_SIGN_IN_REMEDY}`,
    }
  }
}
