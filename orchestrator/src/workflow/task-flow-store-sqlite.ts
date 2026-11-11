// concern: SQLite task flow persistence
/** Carries the local task-flow SQL behind TaskFlowStore. */

import type { Database } from 'bun:sqlite'
import { questionOpenSql } from '../run/question-open.ts'
import * as questions from './task-flow-store-sqlite-questions.ts'
import type {
  TaskFlowProjectionRow,
  TaskFlowStageCursorRow,
  WorkflowCursorInsert,
} from './task-flow-store-types.ts'

const LISTED_STAGE_COLUMNS =
  "number id,record_id,project,workflow_slug,mode_slug,workflow_key,task_record_id,task_flow_record_id,instance_id,session_id,ordinal,step_slug,state,workflow_version_record_id,catalogue_version_record_id,(SELECT n FROM workflow_version WHERE record_id=workflow_version_record_id) workflow_version,(SELECT n FROM step_catalogue_version WHERE record_id=catalogue_version_record_id) catalogue_version,args,autonomy,closed,question,total_steps,created_at,updated_at,enforcement,opened_machine_id,taken_over_from_machine_id,last_advanced_machine_id,revision,(SELECT COUNT(*) FROM workflow_cursor stage WHERE stage.task_flow_record_id=workflow_cursor.task_flow_record_id AND stage.state NOT IN ('done','abandoned')) open_stage_count"

class SqliteTaskFlowStore {
  private readonly database: Database

  constructor(database: Database) {
    this.database = database
  }

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

  stampStageMachine(cursorRecordId: string, revisionIncrement: 0 | 1, machineId: string): void {
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
      .query('UPDATE task_flow SET open_stage_cursor_record_id=?,updated_at=? WHERE record_id=?')
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

  textsForStage<T extends object>(stageRecordId: string): T[] {
    return this.database
      .query<T, [string]>(
        `SELECT record_id id,cursor_record_id,step_ordinal,step_slug,body
         FROM workflow_step_text WHERE cursor_record_id=? ORDER BY step_ordinal,rowid`,
      )
      .all(stageRecordId)
  }

  textByRecordId<T extends object>(recordId: string): T | null {
    return this.database
      .query<T, [string]>(
        'SELECT cursor_record_id,step_ordinal,step_slug,body FROM workflow_step_text WHERE record_id=?',
      )
      .get(recordId)
  }

  textAttachmentByRecordId<T extends object>(recordId: string): T | null {
    return this.database
      .query<T, [string]>(
        `SELECT record_id id,cursor_record_id,step_ordinal,step_slug,body
         FROM workflow_step_text WHERE record_id=?`,
      )
      .get(recordId)
  }

  insertText(input: {
    recordId: string
    stageRecordId: string
    stepOrdinal: number
    stepSlug: string
    body: string
    createdAt: string
  }): string | null {
    return (
      this.database
        .query<{ id: string }, [string, string, number, string, string, string]>(
          `INSERT INTO workflow_step_text(record_id,cursor_record_id,step_ordinal,step_slug,body,created_at)
           VALUES (?,?,?,?,?,?) RETURNING record_id id`,
        )
        .get(
          input.recordId,
          input.stageRecordId,
          input.stepOrdinal,
          input.stepSlug,
          input.body,
          input.createdAt,
        )?.id ?? null
    )
  }

  textRecordIdsForStage(stageRecordId: string): string[] {
    return this.database
      .query<{ record_id: string }, [string]>(
        'SELECT record_id FROM workflow_step_text WHERE cursor_record_id=?',
      )
      .all(stageRecordId)
      .map((row) => row.record_id)
  }

  copiedTextRecordIdsForStage(stageRecordId: string): string[] {
    return this.database
      .query<{ workflow_text_record_id: string }, [string]>(
        'SELECT workflow_text_record_id FROM workflow_text_copy WHERE cursor_record_id=?',
      )
      .all(stageRecordId)
      .map((row) => row.workflow_text_record_id)
  }

  deleteTexts(recordIds: readonly string[]): void {
    const remove = this.database.query('DELETE FROM workflow_step_text WHERE record_id=?')
    for (const id of recordIds) remove.run(id)
  }

  stageProject(recordId: string): string | null {
    return (
      this.database
        .query<{ project: string }, [string]>(
          'SELECT project FROM workflow_cursor WHERE record_id=?',
        )
        .get(recordId)?.project ?? null
    )
  }

  uncopiedTextsForStage<T extends object>(stageRecordId: string): T[] {
    return this.database
      .query<T, [string]>(
        `SELECT t.record_id,t.step_slug,t.body,t.created_at FROM workflow_step_text t
         LEFT JOIN workflow_text_copy c ON c.workflow_text_record_id=t.record_id
         WHERE t.cursor_record_id=? AND c.workflow_text_record_id IS NULL
         ORDER BY t.step_ordinal,t.rowid`,
      )
      .all(stageRecordId)
  }

  recordTextCopy(input: {
    recordId: string
    textRecordId: string
    stageRecordId: string
    documentReference: string
    copiedAt: string
  }): void {
    this.database
      .query(
        `INSERT OR IGNORE INTO workflow_text_copy
         (record_id,workflow_text_record_id,cursor_record_id,task_document_reference,copied_at)
         VALUES (?,?,?,?,?)`,
      )
      .run(
        input.recordId,
        input.textRecordId,
        input.stageRecordId,
        input.documentReference,
        input.copiedAt,
      )
  }

  liveTextAttachment(recordId: string): { cursor: number; step_slug: string; body: string } | null {
    return this.database
      .query<{ cursor: number; step_slug: string; body: string }, [string]>(
        `SELECT c.number cursor,t.step_slug,t.body FROM workflow_step_text t
         JOIN workflow_cursor c ON c.record_id=t.cursor_record_id WHERE t.record_id=?`,
      )
      .get(recordId)
  }

  copiedTextReference(recordId: string): string | null {
    return (
      this.database
        .query<{ task_document_reference: string }, [string]>(
          'SELECT task_document_reference FROM workflow_text_copy WHERE workflow_text_record_id=?',
        )
        .get(recordId)?.task_document_reference ?? null
    )
  }

  openObligationRecordIds(stageRecordId: string): string[] {
    return this.database
      .query<{ record_id: string }, [string]>(
        'SELECT record_id FROM workflow_obligation WHERE cursor_record_id=? AND satisfied_at IS NULL AND abandoned_at IS NULL',
      )
      .all(stageRecordId)
      .map((row) => row.record_id)
  }

  openObligations<T extends object>(stageRecordId: string): T[] {
    return this.database
      .query<T, [string]>(
        `SELECT record_id AS id, floor, require_pull_request, operator_ruling, expected_exit_code,
                expected_status, floor_deferrable,
                (SELECT number FROM workflow_cursor WHERE workflow_cursor.record_id=workflow_obligation.cursor_record_id) AS cursor_number,
                step_ordinal AS stepOrdinal, step_slug AS stepSlug
         FROM workflow_obligation
         WHERE cursor_record_id=? AND satisfied_at IS NULL AND abandoned_at IS NULL ORDER BY rowid`,
      )
      .all(stageRecordId)
  }

  obligationByRecordId<T extends object>(recordId: string): T | null {
    return this.database
      .query<T, [string]>(
        `SELECT record_id AS id, floor, require_pull_request, operator_ruling, expected_exit_code,
                expected_status, floor_deferrable,
                (SELECT number FROM workflow_cursor WHERE workflow_cursor.record_id=workflow_obligation.cursor_record_id) AS cursor_number,
                cursor_record_id,satisfied_at,abandoned_at
         FROM workflow_obligation WHERE record_id=?`,
      )
      .get(recordId)
  }

  nextKeylessInstanceSlot(input: {
    projectRecordId: string
    workflow: string
    mode: string
    sessionId: string | null
    machineId: string
  }): number {
    return this.database
      .query<{ n: number }, [string, string, string, string | null, string | null, string]>(
        `SELECT COUNT(*)+1 n FROM workflow_cursor
         WHERE project_record_id=? AND workflow_slug=? AND mode_slug=? AND workflow_key=''
           AND (session_id=? OR (? IS NULL AND session_id IS NULL AND opened_machine_id=?))`,
      )
      .get(
        input.projectRecordId,
        input.workflow,
        input.mode,
        input.sessionId,
        input.sessionId,
        input.machineId,
      )!.n
  }

  flowForTask(taskRecordId: string): { record_id: string; revision: number } | null {
    return this.database
      .query<{ record_id: string; revision: number }, [string]>(
        'SELECT record_id,revision FROM task_flow WHERE task_record_id=?',
      )
      .get(taskRecordId)
  }

  hasStage(recordId: string): boolean {
    return Boolean(
      this.database
        .query<{ record_id: string }, [string]>(
          'SELECT record_id FROM workflow_cursor WHERE record_id=?',
        )
        .get(recordId),
    )
  }

  assignStageTaskKey(input: {
    recordId: string
    workflowKey: string
    taskRecordId: string | null
    argumentsJson: string
    updatedAt: string
  }): void {
    this.database
      .query(
        "UPDATE workflow_cursor SET workflow_key=?,task_record_id=?,instance_id='',args=?,updated_at=? WHERE record_id=?",
      )
      .run(
        input.workflowKey,
        input.taskRecordId,
        input.argumentsJson,
        input.updatedAt,
        input.recordId,
      )
  }

  stagesNeedingTaskLink(project: string, workflowKey: string) {
    return this.database
      .query<{ record_id: string; revision: number; updated_at: string }, [string, string]>(
        `SELECT record_id,revision,updated_at FROM workflow_cursor
         WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
           AND workflow_key=? AND task_record_id IS NULL ORDER BY record_id`,
      )
      .all(project, workflowKey)
  }

  linkUnhostedStagesToTask(input: {
    taskRecordId: string
    project: string
    workflowKey: string
  }): number {
    return this.database
      .query(
        `UPDATE workflow_cursor SET task_record_id=?
         WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
           AND workflow_key=? AND task_record_id IS NULL`,
      )
      .run(input.taskRecordId, input.project, input.workflowKey).changes
  }

  unlinkedLabelHolder(input: {
    project: string
    workflow: string
    mode: string
    key: string
  }): number | null {
    return (
      this.database
        .query<{ number: number }, [string, string, string, string]>(
          `SELECT number FROM workflow_cursor
           WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
             AND workflow_slug=? AND mode_slug=? AND workflow_key=? AND instance_id=''
           LIMIT 1`,
        )
        .get(input.project, input.workflow, input.mode, input.key)?.number ?? null
    )
  }

  updateReusedStage(input: {
    recordId: string
    argumentsJson: string
    closedJson: string
    sessionId: string | null
    updatedAt: string
    revision: number
  }): void {
    this.database
      .query(
        'UPDATE workflow_cursor SET args=?,closed=?,session_id=COALESCE(?,session_id),updated_at=?,revision=? WHERE record_id=?',
      )
      .run(
        input.argumentsJson,
        input.closedJson,
        input.sessionId,
        input.updatedAt,
        input.revision,
        input.recordId,
      )
  }

  updateServedStage(input: {
    recordId: string
    argumentsJson: string
    closedJson: string
    ordinal: number
    stepSlug: string
    state: string
    question: string | null
    sessionId: string | null
    updatedAt: string
    machineId: string
    revision: number
  }): void {
    this.database
      .query(
        `UPDATE workflow_cursor SET args=?,closed=?,ordinal=?,step_slug=?,state=?,question=?,
         session_id=COALESCE(?,session_id),updated_at=?,opened_machine_id=COALESCE(opened_machine_id,?),
         last_advanced_machine_id=?,revision=? WHERE record_id=?`,
      )
      .run(
        input.argumentsJson,
        input.closedJson,
        input.ordinal,
        input.stepSlug,
        input.state,
        input.question,
        input.sessionId,
        input.updatedAt,
        input.machineId,
        input.machineId,
        input.revision,
        input.recordId,
      )
  }

  resumeStageAfterRuling(input: {
    recordId: string
    sessionId: string | null
    updatedAt: string
    machineId: string
    revision: number
  }): void {
    this.database
      .query(
        `UPDATE workflow_cursor SET state='running',question=NULL,
         session_id=COALESCE(session_id,?),updated_at=?,opened_machine_id=COALESCE(opened_machine_id,?),
         last_advanced_machine_id=?,revision=? WHERE record_id=?`,
      )
      .run(
        input.sessionId,
        input.updatedAt,
        input.machineId,
        input.machineId,
        input.revision,
        input.recordId,
      )
  }

  awaitStageRuling(input: {
    recordId: string
    argumentsJson: string
    closedJson: string
    question: string
    sessionId: string | null
    updatedAt: string
    machineId: string
    revision: number
  }): void {
    this.database
      .query(
        `UPDATE workflow_cursor SET args=?,closed=?,state='awaiting-ruling',question=?,
         session_id=COALESCE(?,session_id),updated_at=?,opened_machine_id=COALESCE(opened_machine_id,?),
         last_advanced_machine_id=?,revision=? WHERE record_id=?`,
      )
      .run(
        input.argumentsJson,
        input.closedJson,
        input.question,
        input.sessionId,
        input.updatedAt,
        input.machineId,
        input.machineId,
        input.revision,
        input.recordId,
      )
  }

  abandonOpenObligations(stageRecordId: string, at: string, reason: string): void {
    this.database
      .query(
        'UPDATE workflow_obligation SET abandoned_at=?,abandoned_reason=? WHERE cursor_record_id=? AND satisfied_at IS NULL AND abandoned_at IS NULL',
      )
      .run(at, reason, stageRecordId)
  }

  abandonStage(input: {
    recordId: string
    closedJson: string
    sessionId: string | null
    updatedAt: string
    machineId: string
    revision: number
  }): void {
    this.database
      .query(`UPDATE workflow_cursor SET state='abandoned',closed=?,question=NULL,
        session_id=COALESCE(?,session_id),updated_at=?,opened_machine_id=COALESCE(opened_machine_id,?),
        last_advanced_machine_id=?,revision=? WHERE record_id=?`)
      .run(
        input.closedJson,
        input.sessionId,
        input.updatedAt,
        input.machineId,
        input.machineId,
        input.revision,
        input.recordId,
      )
  }

  clearFlowOpenStage(input: {
    recordId: string
    updatedAt: string
    machineId: string
    revision: number
  }): void {
    this.database
      .query(
        'UPDATE task_flow SET open_stage_cursor_record_id=NULL,updated_at=?,updated_machine_id=?,revision=? WHERE record_id=?',
      )
      .run(input.updatedAt, input.machineId, input.revision, input.recordId)
  }

  insertObligation(input: {
    id: string
    stageRecordId: string
    stepOrdinal: number
    stepSlug: string
    floor: string
    requirePullRequest: boolean
    operatorRuling: boolean
    expectedExitCode: number
    expectedStatus: string
    floorDeferrable: boolean
    reason: string
    sessionId: string | null
    createdAt: string
  }): void {
    this.database
      .query(`INSERT INTO workflow_obligation
        (record_id,cursor_record_id,step_ordinal,step_slug,floor,require_pull_request,operator_ruling,
         expected_exit_code,expected_status,floor_deferrable,reason,session_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        input.id,
        input.stageRecordId,
        input.stepOrdinal,
        input.stepSlug,
        input.floor,
        input.requirePullRequest ? 1 : 0,
        input.operatorRuling ? 1 : 0,
        input.expectedExitCode,
        input.expectedStatus,
        input.floorDeferrable ? 1 : 0,
        input.reason,
        input.sessionId,
        input.createdAt,
      )
  }

  satisfyObligation(input: {
    id: string
    stageRecordId: string
    satisfiedAt?: string | null
    satisfiedStepOrdinal?: number | null
    satisfiedStepSlug?: string | null
    satisfiedEvidence?: unknown
  }): void {
    this.database
      .query(`UPDATE workflow_obligation SET
        satisfied_at=?,satisfied_step_ordinal=?,satisfied_step_slug=?,satisfied_evidence=?
        WHERE record_id=? AND cursor_record_id=? AND satisfied_at IS NULL`)
      .run(
        input.satisfiedAt ?? null,
        input.satisfiedStepOrdinal ?? null,
        input.satisfiedStepSlug ?? null,
        JSON.stringify(input.satisfiedEvidence ?? null),
        input.id,
        input.stageRecordId,
      )
  }

  advanceStage(input: {
    recordId: string
    argumentsJson: string
    ordinal: number
    stepSlug: string
    state: string
    closedJson: string
    sessionId: string | null
    updatedAt: string
    takenOverFromMachineId: string | null
    machineId: string
    revision: number
  }): void {
    this.database
      .query(`UPDATE workflow_cursor SET args=?,ordinal=?,step_slug=?,state=?,closed=?,question=NULL,
        session_id=COALESCE(?,session_id),updated_at=?,taken_over_from_machine_id=COALESCE(?,taken_over_from_machine_id),
        opened_machine_id=COALESCE(opened_machine_id,?),last_advanced_machine_id=?,revision=? WHERE record_id=?`)
      .run(
        input.argumentsJson,
        input.ordinal,
        input.stepSlug,
        input.state,
        input.closedJson,
        input.sessionId,
        input.updatedAt,
        input.takenOverFromMachineId,
        input.machineId,
        input.machineId,
        input.revision,
        input.recordId,
      )
  }

  closeOutShipTaskStage<T extends object>(sessionId: string, project: string, branch: string): T[] {
    return questions.closeOutShipTaskStage<T>(this.database, sessionId, project, branch)
  }

  waitingWorkflowQuestions<T extends object>(): T[] {
    return questions.waitingWorkflowQuestions<T>(this.database)
  }

  cursorWorkForSession<T extends object>(sessionId: string): T[] {
    return questions.cursorWorkForSession<T>(this.database, sessionId)
  }

  cursorLifecycleForSession<T extends object>(sessionId: string): T[] {
    return questions.cursorLifecycleForSession<T>(this.database, sessionId)
  }

  openStagesForSession<T extends object>(sessionId: string): T[] {
    return questions.openStagesForSession<T>(this.database, sessionId)
  }

  openWorkflowQuestionCountForSession(sessionId: string): number {
    return questions.openWorkflowQuestionCountForSession(this.database, sessionId)
  }

  workflowInboxQuestions<T extends object>(): T[] {
    return questions.workflowInboxQuestions<T>(this.database)
  }

  rulingRows<T extends object>(input: {
    kind: 'workflow' | 'run' | 'all'
    since?: string
    after: number | null
    cursor: number | null
  }): T[] {
    return questions.rulingRows<T>(this.database, input)
  }

  rulingFileQuestion<T extends object>(questionId: string): T | null {
    return questions.rulingFileQuestion<T>(this.database, questionId)
  }

  questionOutboxRow<T extends object>(questionId: string): T | null {
    return questions.questionOutboxRow<T>(this.database, questionId)
  }

  questionCloseFacts<T extends object>(questionId: string): T | null {
    return questions.questionCloseFacts<T>(this.database, questionId)
  }

  overturnRulingRow<T extends object>(questionId: string): T | null {
    return questions.overturnRulingRow<T>(this.database, questionId)
  }

  unlinkedWorkflowQuestionIds(project: string, workflowKey: string): string[] {
    return questions.unlinkedWorkflowQuestionIds(this.database, project, workflowKey)
  }

  pendingTaskLinks<T extends object>(table: 'workflow_cursor' | 'question'): T[] {
    return questions.pendingTaskLinks<T>(this.database, table)
  }

  linkedTaskReferences<T extends object>(table: 'workflow_cursor' | 'question'): T[] {
    return questions.linkedTaskReferences<T>(this.database, table)
  }

  projectReferenceCounts(projectRecordId: string): {
    workflow_cursor: number
    task_flow: number
  } {
    return questions.projectTaskFlowReferenceCounts(this.database, projectRecordId)
  }

  renameStageProject(currentName: string, nextName: string): void {
    questions.renameStageProject(this.database, currentName, nextName)
  }

  taskRulingRows<T extends object>(project: string, taskRecordId: string, limit: number): T[] {
    return questions.taskRulingRows<T>(this.database, project, taskRecordId, limit)
  }

  localQuestionProjects(): Array<{ project: string | null }> {
    return questions.localQuestionProjects(this.database)
  }
}

export function sqliteTaskFlowStore(database: Database): SqliteTaskFlowStore {
  return new SqliteTaskFlowStore(database)
}
