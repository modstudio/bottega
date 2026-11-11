// concern: SQLite task flow persistence
/** Carries the local task-flow SQL behind TaskFlowStore. */

import type { Database } from 'bun:sqlite'
import type {
  TaskFlowProjectionRow,
  TaskFlowStageCursorRow,
  TaskFlowStore,
  WorkflowCursorInsert,
} from './task-flow-store.ts'
import { questionOpenSql } from '../run/question-open.ts'

const LISTED_STAGE_COLUMNS =
  "number id,record_id,project,workflow_slug,mode_slug,workflow_key,task_record_id,task_flow_record_id,instance_id,session_id,ordinal,step_slug,state,workflow_version_record_id,catalogue_version_record_id,(SELECT n FROM workflow_version WHERE record_id=workflow_version_record_id) workflow_version,(SELECT n FROM step_catalogue_version WHERE record_id=catalogue_version_record_id) catalogue_version,args,autonomy,closed,question,total_steps,created_at,updated_at,enforcement,opened_machine_id,taken_over_from_machine_id,last_advanced_machine_id,revision,(SELECT COUNT(*) FROM workflow_cursor stage WHERE stage.task_flow_record_id=workflow_cursor.task_flow_record_id AND stage.state NOT IN ('done','abandoned')) open_stage_count"

class SqliteTaskFlowStore implements TaskFlowStore {
  constructor(private readonly database: Database) {}

  retireStageIdentity(input: {
    project: string
    workflow: string
    mode: string
    key: string
    exceptRecordId: string | null
  }): void {
    this.database
      .query(
        `UPDATE workflow_cursor SET instance_id=instance_id || '#' || number
         WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
           AND workflow_slug=? AND mode_slug=? AND workflow_key=? AND instance_id=''
           AND (? IS NULL OR record_id<>?)
           AND state IN ('done','abandoned')`,
      )
      .run(
        input.project,
        input.workflow,
        input.mode,
        input.key,
        input.exceptRecordId,
        input.exceptRecordId,
      )
  }

  conflictingHostedStage(input: {
    projectRecordId: string
    workflow: string
    mode: string
    key: string
    recordId: string
  }): { number: number; record_id: string } | null {
    return this.database
      .query<{ number: number; record_id: string }, [string, string, string, string, string]>(
        `SELECT number,record_id FROM workflow_cursor
         WHERE project_record_id=? AND workflow_slug=? AND mode_slug=? AND workflow_key=?
           AND instance_id='' AND state NOT IN ('done','abandoned') AND record_id<>?`,
      )
      .get(input.projectRecordId, input.workflow, input.mode, input.key, input.recordId)
  }

  insertStage(row: WorkflowCursorInsert, conflict: 'local-identity' | 'hosted-record'): string {
    const projectRecordId =
      row.projectRecordId ??
      this.database
        .query<{ record_id: string }, [string]>('SELECT record_id FROM project WHERE name=?')
        .get(row.project)!.record_id
    const conflictSql =
      conflict === 'local-identity'
        ? `ON CONFLICT(project_record_id,workflow_slug,mode_slug,workflow_key,instance_id) DO UPDATE SET
             session_id=COALESCE(excluded.session_id,workflow_cursor.session_id),
             updated_at=excluded.updated_at`
        : ''
    return this.database
      .query<{ record_id: string }, (string | number | null)[]>(
        `INSERT INTO workflow_cursor
         (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,task_record_id,
          task_flow_record_id,instance_id,session_id,workflow_version_record_id,catalogue_version_record_id,
          args,autonomy,ordinal,step_slug,state,closed,question,total_steps,created_at,updated_at,enforcement,
          opened_machine_id,taken_over_from_machine_id,last_advanced_machine_id,revision)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ${conflictSql}
         RETURNING record_id`,
      )
      .get(
        row.recordId,
        row.project,
        projectRecordId,
        row.workflow,
        row.mode,
        row.workflowKey,
        row.taskRecordId,
        row.taskFlowRecordId,
        row.instanceId,
        row.sessionId,
        row.workflowVersionRecordId,
        row.catalogueVersionRecordId,
        row.args,
        row.autonomy,
        row.ordinal,
        row.stepSlug,
        row.state,
        row.closed,
        row.question,
        row.totalSteps,
        row.createdAt,
        row.updatedAt,
        row.enforcement,
        row.openedMachineId,
        row.takenOverFromMachineId,
        row.lastAdvancedMachineId,
        row.revision,
      )!.record_id
  }

  openStageForTask(taskRecordId: string): TaskFlowStageCursorRow | null {
    return this.database
      .query<TaskFlowStageCursorRow, [string]>(
        `SELECT cursor.number id,cursor.record_id,cursor.project,cursor.workflow_slug,cursor.mode_slug,
         cursor.workflow_key,cursor.task_record_id,cursor.task_flow_record_id,cursor.instance_id,
         cursor.session_id,cursor.ordinal,cursor.step_slug,cursor.state,cursor.workflow_version_record_id,
         cursor.catalogue_version_record_id,
         (SELECT n FROM workflow_version WHERE record_id=cursor.workflow_version_record_id) workflow_version,
         (SELECT n FROM step_catalogue_version WHERE record_id=cursor.catalogue_version_record_id) catalogue_version,
         cursor.args,cursor.autonomy,cursor.closed,cursor.question,cursor.total_steps,cursor.created_at,
         cursor.updated_at,cursor.enforcement,cursor.opened_machine_id,cursor.taken_over_from_machine_id,
         cursor.last_advanced_machine_id,cursor.revision
         FROM task_flow flow JOIN workflow_cursor cursor
         ON cursor.record_id=flow.open_stage_cursor_record_id WHERE flow.task_record_id=?`,
      )
      .get(taskRecordId)
  }

  flowRecordIdForTask(taskRecordId: string): string | null {
    return (
      this.database
        .query<{ record_id: string }, [string]>(
          'SELECT record_id FROM task_flow WHERE task_record_id=?',
        )
        .get(taskRecordId)?.record_id ?? null
    )
  }

  cacheAdoptedFlow(input: {
    project: string
    taskRecordId: string
    cursorRecordId: string
    flowRecordId: string
    flowRevision: number
    stageRevision: number
    state: string | null
    at: string
    machineId: string
  }): void {
    this.database
      .query(
        `INSERT INTO task_flow
         (record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,
          created_at,updated_at,opening_machine_id,updated_machine_id,revision)
         VALUES (?,?,(SELECT record_id FROM project WHERE name=?),COALESCE(?,'open'),?,?,?,?,?,?)
         ON CONFLICT(task_record_id) DO UPDATE SET
         state=COALESCE(excluded.state,task_flow.state),
         open_stage_cursor_record_id=excluded.open_stage_cursor_record_id,
         updated_at=excluded.updated_at,updated_machine_id=excluded.updated_machine_id,
         revision=excluded.revision`,
      )
      .run(
        input.flowRecordId,
        input.taskRecordId,
        input.project,
        input.state,
        input.cursorRecordId,
        input.at,
        input.at,
        input.machineId,
        input.machineId,
        input.flowRevision,
      )
    this.database
      .query(
        `UPDATE workflow_cursor SET task_record_id=?,task_flow_record_id=?,revision=?
         WHERE record_id=?`,
      )
      .run(input.taskRecordId, input.flowRecordId, input.stageRevision, input.cursorRecordId)
  }

  stampFlowMachine(flowRecordId: string, machineId: string): void {
    this.database
      .query(
        `UPDATE task_flow SET opening_machine_id=COALESCE(opening_machine_id,?),
         updated_machine_id=?,revision=revision+1 WHERE record_id=?`,
      )
      .run(machineId, machineId, flowRecordId)
  }

  stampStageMachine(
    cursorRecordId: string,
    revisionIncrement: 0 | 1,
    machineId: string,
  ): void {
    this.database
      .query(
        `UPDATE workflow_cursor SET opened_machine_id=COALESCE(opened_machine_id,?),
         last_advanced_machine_id=?,revision=revision+? WHERE record_id=?`,
      )
      .run(machineId, machineId, revisionIncrement, cursorRecordId)
  }

  projectFlow(input: {
    recordId: string
    project: string
    taskRecordId: string
    state: string | null
    at: string
    machineId: string
  }): TaskFlowProjectionRow {
    return this.database
      .query<
        TaskFlowProjectionRow,
        [string, string, string, string | null, string, string, string, string, string | null]
      >(
        `INSERT INTO task_flow
         (record_id,task_record_id,project_record_id,state,created_at,updated_at,
          opening_machine_id,updated_machine_id,revision)
         VALUES (?, ?, (SELECT record_id FROM project WHERE name=?), COALESCE(?, 'open'), ?, ?, ?, ?, 1)
         ON CONFLICT(task_record_id) DO UPDATE
           SET state=COALESCE(?,task_flow.state),updated_at=excluded.updated_at,
               opening_machine_id=COALESCE(task_flow.opening_machine_id,excluded.opening_machine_id),
               updated_machine_id=excluded.updated_machine_id,revision=task_flow.revision+1
         RETURNING record_id,open_stage_cursor_record_id`,
      )
      .get(
        input.recordId,
        input.taskRecordId,
        input.project,
        input.state,
        input.at,
        input.at,
        input.machineId,
        input.machineId,
        input.state,
      )!
  }

  flowProjectionForTask(taskRecordId: string): TaskFlowProjectionRow | null {
    return this.database
      .query<TaskFlowProjectionRow, [string]>(
        'SELECT record_id,open_stage_cursor_record_id FROM task_flow WHERE task_record_id=?',
      )
      .get(taskRecordId)
  }

  attachStageToFlow(input: {
    flowRecordId: string
    cursorRecordId: string
    at: string
    machineId: string
  }): void {
    this.database
      .query('UPDATE workflow_cursor SET task_flow_record_id=? WHERE record_id=?')
      .run(input.flowRecordId, input.cursorRecordId)
    this.stampStageMachine(input.cursorRecordId, 1, input.machineId)
    this.database
      .query(
        'UPDATE task_flow SET open_stage_cursor_record_id=?,updated_at=? WHERE record_id=?',
      )
      .run(input.cursorRecordId, input.at, input.flowRecordId)
    this.stampFlowMachine(input.flowRecordId, input.machineId)
  }

  stageByHandle(cursor: number): TaskFlowStageCursorRow | null {
    return this.database
      .query<TaskFlowStageCursorRow, [number]>(
        `SELECT ${LISTED_STAGE_COLUMNS} FROM workflow_cursor WHERE number=?`,
      )
      .get(cursor)
  }

  stageByRecordId(recordId: string): TaskFlowStageCursorRow | null {
    return this.database
      .query<TaskFlowStageCursorRow, [string]>(
        `SELECT ${LISTED_STAGE_COLUMNS} FROM workflow_cursor WHERE record_id=?`,
      )
      .get(recordId)
  }

  latestStageForTask(input: {
    project: string
    workflow: string
    mode: string
    taskRecordId: string
  }): TaskFlowStageCursorRow | null {
    return this.database
      .query<TaskFlowStageCursorRow, [string, string, string, string]>(
        `SELECT ${LISTED_STAGE_COLUMNS} FROM workflow_cursor
         WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
           AND workflow_slug=? AND mode_slug=? AND task_record_id=?
           AND instance_id='' ORDER BY number DESC LIMIT 1`,
      )
      .get(input.project, input.workflow, input.mode, input.taskRecordId)
  }

  openKeylessStages(input: {
    project: string
    workflow: string
    mode: string
    sessionId: string
    untouched: boolean
  }): TaskFlowStageCursorRow[] {
    const rows = this.database
      .query<TaskFlowStageCursorRow, [string, string, string, string]>(
        `SELECT ${LISTED_STAGE_COLUMNS} FROM workflow_cursor
         WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
           AND workflow_slug=? AND mode_slug=? AND workflow_key=''
           AND session_id=? AND state NOT IN ('done','abandoned')
           ${input.untouched ? 'AND ordinal=0 ' : ''}ORDER BY number`,
      )
      .all(input.project, input.workflow, input.mode, input.sessionId)
    return rows
  }

  activeStageModes(input: {
    project: string
    workflow: string
    taskRecordId: string | null
    key: string
    sessionId: string
  }): Array<{ mode_slug: string }> {
    return input.key
      ? this.database
          .query<{ mode_slug: string }, [string, string, string | null, string]>(
            `SELECT DISTINCT mode_slug FROM workflow_cursor
             WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
               AND workflow_slug=? AND (task_record_id=? OR workflow_key=?)
               AND instance_id=''
               AND state NOT IN ('done','abandoned') ORDER BY mode_slug`,
          )
          .all(input.project, input.workflow, input.taskRecordId, input.key)
      : this.database
          .query<{ mode_slug: string }, [string, string, string]>(
            `SELECT DISTINCT mode_slug FROM workflow_cursor
             WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
               AND workflow_slug=? AND workflow_key=''
               AND session_id=?
               AND state NOT IN ('done','abandoned') ORDER BY mode_slug`,
          )
          .all(input.project, input.workflow, input.sessionId)
  }

  listOpenStages<T extends object>(input: { project?: string; sessionId?: string }): T[] {
    const clauses = [`state NOT IN ('done','abandoned')`]
    const values: string[] = []
    if (input.project) {
      clauses.push('project_record_id=(SELECT record_id FROM project WHERE name=?)')
      values.push(input.project)
    }
    if (input.sessionId) {
      clauses.push('session_id=?')
      values.push(input.sessionId)
    }
    return this.database
      .query<T, string[]>(
        `SELECT ${LISTED_STAGE_COLUMNS},
         (SELECT q.number FROM question q
          WHERE q.workflow_cursor_record_id=workflow_cursor.record_id
            AND ${questionOpenSql('q')} LIMIT 1) question_number
         FROM workflow_cursor WHERE ${clauses.join(' AND ')} ORDER BY updated_at,number`,
      )
      .all(...values)
  }

  openStageWorktrees(): Array<{
    number: number
    workflow: string
    project: string
    args: string
  }> {
    return this.database
      .query<{ number: number; workflow: string; project: string; args: string }, []>(
        `SELECT number,workflow_slug workflow,project,args FROM workflow_cursor
         WHERE state NOT IN ('done','abandoned')
         ORDER BY number`,
      )
      .all()
  }

  activeStageAutonomy(project: string, taskRecordId: string): Array<{ autonomy: string | null }> {
    return this.database
      .query<{ autonomy: string | null }, [string, string]>(
        `SELECT autonomy FROM workflow_cursor
         WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
           AND task_record_id=? AND state IN ('running','awaiting-ruling')
         ORDER BY updated_at DESC,number DESC`,
      )
      .all(project, taskRecordId)
  }

  stageIdentityMap(): Array<{ number: number; record_id: string }> {
    return this.database
      .query<{ number: number; record_id: string }, []>(
        'SELECT number,record_id FROM workflow_cursor ORDER BY number',
      )
      .all()
  }

  stageHoldingTaskKey(input: {
    project: string
    workflow: string
    mode: string
    key: string
  }): { id: number } | null {
    return this.database
      .query<{ id: number }, [string, string, string, string]>(
        `SELECT number id FROM workflow_cursor
         WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
           AND workflow_slug=? AND mode_slug=? AND workflow_key=?
           AND state NOT IN ('done','abandoned') LIMIT 1`,
      )
      .get(input.project, input.workflow, input.mode, input.key)
  }

  stageRevision(recordId: string): number | null {
    return (
      this.database
        .query<{ revision: number }, [string]>(
          'SELECT revision FROM workflow_cursor WHERE record_id=?',
        )
        .get(recordId)?.revision ?? null
    )
  }

  flowState(recordId: string): {
    record_id: string
    revision: number
    open_stage_cursor_record_id: string | null
  } | null {
    return this.database
      .query<
        { record_id: string; revision: number; open_stage_cursor_record_id: string | null },
        [string]
      >('SELECT record_id,revision,open_stage_cursor_record_id FROM task_flow WHERE record_id=?')
      .get(recordId)
  }
}

export function sqliteTaskFlowStore(database: Database): TaskFlowStore {
  return new SqliteTaskFlowStore(database)
}
