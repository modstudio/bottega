// concern: SQLite task flow persistence
/** Carries the local task-flow SQL behind TaskFlowStore. */

import type { Database } from 'bun:sqlite'
import { writeTransaction } from '../database/db.ts'
import type {
  TaskFlowIntent,
  TaskFlowIntentInput,
  TaskFlowIntentResult,
} from '../record/record-task-flow-write-contract.ts'
import { questionOpenSql } from '../run/question-open.ts'
import * as questions from './task-flow-store-sqlite-questions.ts'
import { writeSqliteTaskFlow } from './task-flow-store-sqlite-write.ts'
import type {
  TaskFlowCloseOutStageRow,
  TaskFlowCursorLifecycleRow,
  TaskFlowCursorWorkRow,
  TaskFlowInboxQuestionRow,
  TaskFlowLinkedTaskReferenceRow,
  TaskFlowListedStageRow,
  TaskFlowObligationRow,
  TaskFlowOpenObligationRow,
  TaskFlowOpenSessionStageRow,
  TaskFlowOverturnRulingRow,
  TaskFlowPendingTaskLinkRow,
  TaskFlowProjectionRow,
  TaskFlowQuestionCloseRow,
  TaskFlowQuestionOutboxRow,
  TaskFlowRulingFileRow,
  TaskFlowRulingRow,
  TaskFlowStageCursorRow,
  TaskFlowTaskRulingRow,
  TaskFlowTextBodyRow,
  TaskFlowTextRow,
  TaskFlowUncopiedTextRow,
  TaskFlowWaitingQuestionRow,
  WorkflowCursorInsert,
} from './task-flow-store-types.ts'

const STAGE_COLUMNS =
  'cursor.number id,cursor.record_id,cursor.project,cursor.workflow_slug,cursor.mode_slug,cursor.workflow_key,cursor.task_record_id,cursor.task_flow_record_id,cursor.instance_id,cursor.session_id,cursor.ordinal,cursor.step_slug,cursor.state,cursor.workflow_version_record_id,cursor.catalogue_version_record_id,(SELECT n FROM workflow_version WHERE record_id=cursor.workflow_version_record_id) workflow_version,(SELECT n FROM step_catalogue_version WHERE record_id=cursor.catalogue_version_record_id) catalogue_version,cursor.args,cursor.autonomy,cursor.closed,cursor.question,cursor.total_steps,cursor.created_at,cursor.updated_at,cursor.enforcement,cursor.opened_machine_id,cursor.taken_over_from_machine_id,cursor.last_advanced_machine_id,cursor.revision'

const LISTED_STAGE_COLUMNS = `${STAGE_COLUMNS},(SELECT COUNT(*) FROM workflow_cursor stage WHERE stage.task_flow_record_id=cursor.task_flow_record_id AND stage.state NOT IN ('done','abandoned')) open_stage_count`

const WORKFLOW_OBLIGATION_FLOOR_COLUMNS = `record_id AS id, floor, require_pull_request,
  operator_ruling, expected_exit_code, expected_status, floor_deferrable,
  (SELECT number FROM workflow_cursor WHERE workflow_cursor.record_id=workflow_obligation.cursor_record_id) AS cursor_number`

class SqliteTaskFlowStore {
  private readonly database: Database

  constructor(database: Database) {
    this.database = database
  }

  write<K extends TaskFlowIntent>(
    intent: K,
    payload: TaskFlowIntentInput<K>,
    applied?: TaskFlowIntentResult<K> | null,
  ): TaskFlowIntentResult<K> {
    return writeTransaction(() => {
      if (intent === 'compose') {
        const stage = (payload as TaskFlowIntentInput<'compose'>).stageInsert
        if (stage?.workflowKey && stage.instanceId === '')
          this.retireStageIdentity({
            project: this.database
              .query<{ name: string }, [string]>('SELECT name FROM project WHERE record_id=?')
              .get(stage.projectId)!.name,
            workflow: stage.workflow,
            mode: stage.mode,
            key: stage.workflowKey,
            exceptRecordId: stage.id,
          })
      }
      return writeSqliteTaskFlow(this.database, intent, payload, applied)
    }, this.database)
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
        row.projectRecordId,
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
        `SELECT ${STAGE_COLUMNS}
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
    writeTransaction(() => {
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
    }, this.database)
  }

  flowProjectionForTask(taskRecordId: string): TaskFlowProjectionRow | null {
    return this.database
      .query<TaskFlowProjectionRow, [string]>(
        'SELECT record_id,open_stage_cursor_record_id FROM task_flow WHERE task_record_id=?',
      )
      .get(taskRecordId)
  }

  stageByHandle(cursor: number): TaskFlowStageCursorRow | null {
    return this.database
      .query<TaskFlowStageCursorRow, [number]>(
        `SELECT ${LISTED_STAGE_COLUMNS} FROM workflow_cursor cursor WHERE cursor.number=?`,
      )
      .get(cursor)
  }

  stageByRecordId(recordId: string): TaskFlowStageCursorRow | null {
    return this.database
      .query<TaskFlowStageCursorRow, [string]>(
        `SELECT ${LISTED_STAGE_COLUMNS} FROM workflow_cursor cursor WHERE cursor.record_id=?`,
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
        `SELECT ${LISTED_STAGE_COLUMNS} FROM workflow_cursor cursor
         WHERE cursor.project_record_id=(SELECT record_id FROM project WHERE name=?)
           AND cursor.workflow_slug=? AND cursor.mode_slug=? AND cursor.task_record_id=?
           AND cursor.instance_id='' ORDER BY cursor.number DESC LIMIT 1`,
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
        `SELECT ${LISTED_STAGE_COLUMNS} FROM workflow_cursor cursor
         WHERE cursor.project_record_id=(SELECT record_id FROM project WHERE name=?)
           AND cursor.workflow_slug=? AND cursor.mode_slug=? AND cursor.workflow_key=''
           AND cursor.session_id=? AND cursor.state NOT IN ('done','abandoned')
           ${input.untouched ? 'AND cursor.ordinal=0 ' : ''}ORDER BY cursor.number`,
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

  listOpenStages(input: { project?: string; sessionId?: string }): TaskFlowListedStageRow[] {
    const clauses = [`cursor.state NOT IN ('done','abandoned')`]
    const values: string[] = []
    if (input.project) {
      clauses.push('cursor.project_record_id=(SELECT record_id FROM project WHERE name=?)')
      values.push(input.project)
    }
    if (input.sessionId) {
      clauses.push('cursor.session_id=?')
      values.push(input.sessionId)
    }
    return this.database
      .query<TaskFlowListedStageRow, string[]>(
        `SELECT ${LISTED_STAGE_COLUMNS},
         (SELECT q.number FROM question q
          WHERE q.workflow_cursor_record_id=cursor.record_id
            AND ${questionOpenSql('q')} LIMIT 1) question_number
         FROM workflow_cursor cursor WHERE ${clauses.join(' AND ')}
         ORDER BY cursor.updated_at,cursor.number`,
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

  textsForStage(stageRecordId: string): TaskFlowTextRow[] {
    return this.database
      .query<TaskFlowTextRow, [string]>(
        `SELECT record_id id,cursor_record_id,step_ordinal,step_slug,body
         FROM workflow_step_text WHERE cursor_record_id=? ORDER BY step_ordinal,rowid`,
      )
      .all(stageRecordId)
  }

  textByRecordId(recordId: string): TaskFlowTextBodyRow | null {
    return this.database
      .query<TaskFlowTextBodyRow, [string]>(
        'SELECT cursor_record_id,step_ordinal,step_slug,body FROM workflow_step_text WHERE record_id=?',
      )
      .get(recordId)
  }

  textAttachmentByRecordId(recordId: string): TaskFlowTextRow | null {
    return this.database
      .query<TaskFlowTextRow, [string]>(
        `SELECT record_id id,cursor_record_id,step_ordinal,step_slug,body
         FROM workflow_step_text WHERE record_id=?`,
      )
      .get(recordId)
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

  stageProject(recordId: string): string | null {
    return (
      this.database
        .query<{ project: string }, [string]>(
          'SELECT project FROM workflow_cursor WHERE record_id=?',
        )
        .get(recordId)?.project ?? null
    )
  }

  uncopiedTextsForStage(stageRecordId: string): TaskFlowUncopiedTextRow[] {
    return this.database
      .query<TaskFlowUncopiedTextRow, [string]>(
        `SELECT t.record_id,t.step_slug,t.body,t.created_at FROM workflow_step_text t
         LEFT JOIN workflow_text_copy c ON c.workflow_text_record_id=t.record_id
         WHERE t.cursor_record_id=? AND c.workflow_text_record_id IS NULL
         ORDER BY t.step_ordinal,t.rowid`,
      )
      .all(stageRecordId)
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

  openObligations(stageRecordId: string): TaskFlowOpenObligationRow[] {
    return this.database
      .query<TaskFlowOpenObligationRow, [string]>(
        `SELECT ${WORKFLOW_OBLIGATION_FLOOR_COLUMNS},
                step_ordinal AS stepOrdinal, step_slug AS stepSlug
         FROM workflow_obligation
         WHERE cursor_record_id=? AND satisfied_at IS NULL AND abandoned_at IS NULL ORDER BY rowid`,
      )
      .all(stageRecordId)
  }

  obligationByRecordId(recordId: string): TaskFlowObligationRow | null {
    return this.database
      .query<TaskFlowObligationRow, [string]>(
        `SELECT ${WORKFLOW_OBLIGATION_FLOOR_COLUMNS},cursor_record_id,satisfied_at,abandoned_at
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

  stagesNeedingTaskLink(project: string, workflowKey: string) {
    return this.database
      .query<{ record_id: string; revision: number; updated_at: string }, [string, string]>(
        `SELECT record_id,revision,updated_at FROM workflow_cursor
         WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
           AND workflow_key=? AND task_record_id IS NULL ORDER BY record_id`,
      )
      .all(project, workflowKey)
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

  closeOutShipTaskStage(
    sessionId: string,
    project: string,
    branch: string,
  ): TaskFlowCloseOutStageRow[] {
    return questions.closeOutShipTaskStage(this.database, sessionId, project, branch)
  }

  waitingWorkflowQuestions(): TaskFlowWaitingQuestionRow[] {
    return questions.waitingWorkflowQuestions(this.database)
  }

  cursorWorkForSession(sessionId: string): TaskFlowCursorWorkRow[] {
    return questions.cursorWorkForSession(this.database, sessionId)
  }

  cursorLifecycleForSession(sessionId: string): TaskFlowCursorLifecycleRow[] {
    return questions.cursorLifecycleForSession(this.database, sessionId)
  }

  openStagesForSession(sessionId: string): TaskFlowOpenSessionStageRow[] {
    return questions.openStagesForSession(this.database, sessionId)
  }

  openWorkflowQuestionCountForSession(sessionId: string): number {
    return questions.openWorkflowQuestionCountForSession(this.database, sessionId)
  }

  workflowInboxQuestions(): TaskFlowInboxQuestionRow[] {
    return questions.workflowInboxQuestions(this.database)
  }

  rulingRows(input: {
    kind: 'workflow' | 'run' | 'all'
    since?: string
    after: number | null
    cursor: number | null
  }): TaskFlowRulingRow[] {
    return questions.rulingRows(this.database, input)
  }

  rulingFileQuestion(questionId: string): TaskFlowRulingFileRow | null {
    return questions.rulingFileQuestion(this.database, questionId)
  }

  questionOutboxRow(questionId: string): TaskFlowQuestionOutboxRow | null {
    return questions.questionOutboxRow(this.database, questionId)
  }

  questionCloseFacts(questionId: string): TaskFlowQuestionCloseRow | null {
    return questions.questionCloseFacts(this.database, questionId)
  }

  overturnRulingRow(questionId: string): TaskFlowOverturnRulingRow | null {
    return questions.overturnRulingRow(this.database, questionId)
  }

  unlinkedWorkflowQuestionIds(project: string, workflowKey: string): string[] {
    return questions.unlinkedWorkflowQuestionIds(this.database, project, workflowKey)
  }

  pendingTaskLinks(table: 'workflow_cursor' | 'question'): TaskFlowPendingTaskLinkRow[] {
    return questions.pendingTaskLinks(this.database, table)
  }

  linkedTaskReferences(table: 'workflow_cursor' | 'question'): TaskFlowLinkedTaskReferenceRow[] {
    return questions.linkedTaskReferences(this.database, table)
  }

  projectReferenceCounts(projectRecordId: string): {
    workflow_cursor: number
    task_flow: number
  } {
    return {
      workflow_cursor: this.database
        .query<{ n: number }, [string]>(
          'SELECT COUNT(*) AS n FROM workflow_cursor WHERE project_record_id=?',
        )
        .get(projectRecordId)!.n,
      task_flow: this.database
        .query<{ n: number }, [string]>(
          'SELECT COUNT(*) AS n FROM task_flow WHERE project_record_id=?',
        )
        .get(projectRecordId)!.n,
    }
  }

  relinkProjectReferences(
    oldRecordId: string,
    newRecordId: string,
  ): Record<'task_flow' | 'workflow_cursor', number> {
    return writeTransaction(
      () => ({
        workflow_cursor: this.database
          .query('UPDATE workflow_cursor SET project_record_id=? WHERE project_record_id=?')
          .run(newRecordId, oldRecordId).changes,
        task_flow: this.database
          .query('UPDATE task_flow SET project_record_id=? WHERE project_record_id=?')
          .run(newRecordId, oldRecordId).changes,
      }),
      this.database,
    )
  }

  renameStageProject(currentName: string, nextName: string): void {
    questions.renameStageProject(this.database, currentName, nextName)
  }

  taskRulingRows(project: string, taskRecordId: string, limit: number): TaskFlowTaskRulingRow[] {
    return questions.taskRulingRows(this.database, project, taskRecordId, limit)
  }

  localQuestionProjects(): Array<{ project: string | null }> {
    return questions.localQuestionProjects(this.database)
  }
}

export function sqliteTaskFlowStore(database: Database): SqliteTaskFlowStore {
  return new SqliteTaskFlowStore(database)
}
