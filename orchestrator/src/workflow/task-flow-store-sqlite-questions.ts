// concern: SQLite task-flow reads joined to local questions
/** Carries the unchanged cross-table reads used before questions move to the record. */

import type { Database } from 'bun:sqlite'
import { questionOpenSql, questionTaskHolderSql } from '../run/question-open.ts'
import type {
  TaskFlowCloseOutStageRow,
  TaskFlowCursorLifecycleRow,
  TaskFlowCursorWorkRow,
  TaskFlowInboxQuestionRow,
  TaskFlowLinkedTaskReferenceRow,
  TaskFlowOpenSessionStageRow,
  TaskFlowOverturnRulingRow,
  TaskFlowPendingTaskLinkRow,
  TaskFlowQuestionCloseRow,
  TaskFlowQuestionOutboxRow,
  TaskFlowRulingFileRow,
  TaskFlowRulingRow,
  TaskFlowTaskRulingRow,
  TaskFlowWaitingQuestionRow,
} from './task-flow-store-types.ts'

export const closeOutShipTaskStage = (
  database: Database,
  sessionId: string,
  project: string,
  branch: string,
): TaskFlowCloseOutStageRow[] =>
  database
    .query<TaskFlowCloseOutStageRow, [string, string, string]>(
      `SELECT number id, step_slug, workflow_slug, project, args
         FROM workflow_cursor
        WHERE session_id = ?
          AND project = ?
          AND workflow_slug = 'ship-task'
          AND state IN ('running','awaiting-ruling')
          AND json_extract(args, '$.branch') = ?
        ORDER BY number`,
    )
    .all(sessionId, project, branch)

export const waitingWorkflowQuestions = (database: Database): TaskFlowWaitingQuestionRow[] =>
  database
    .query<TaskFlowWaitingQuestionRow, []>(
      `SELECT c.number id,c.record_id workflow_cursor_record_id,c.project,q.record_id question_record_id,q.workflow_key task_key,q.question,q.asked_at waiting_since,
              c.workflow_slug,c.mode_slug,c.args,c.session_id
         FROM workflow_cursor c JOIN question q ON q.workflow_cursor_record_id=c.record_id
        WHERE c.state='awaiting-ruling' AND ${questionOpenSql('q')}`,
    )
    .all()

export const cursorWorkForSession = (
  database: Database,
  sessionId: string,
): TaskFlowCursorWorkRow[] =>
  database
    .query<TaskFlowCursorWorkRow, [string]>(
      "SELECT workflow_key key,closed FROM workflow_cursor WHERE session_id=? AND workflow_key<>''",
    )
    .all(sessionId)

export const cursorLifecycleForSession = (
  database: Database,
  sessionId: string,
): TaskFlowCursorLifecycleRow[] =>
  database
    .query<TaskFlowCursorLifecycleRow, [string]>(
      'SELECT record_id,number,created_at,updated_at,state,closed FROM workflow_cursor WHERE session_id=?',
    )
    .all(sessionId)

export const openStagesForSession = (
  database: Database,
  sessionId: string,
): TaskFlowOpenSessionStageRow[] =>
  database
    .query<TaskFlowOpenSessionStageRow, [string]>(
      `SELECT record_id,number,project,workflow_slug,state,
        (SELECT q.record_id FROM question q
          WHERE q.workflow_cursor_record_id=workflow_cursor.record_id
            AND ${questionOpenSql('q')} LIMIT 1) open_question_record_id
       FROM workflow_cursor
        WHERE session_id=? AND state NOT IN ('done','abandoned') ORDER BY number`,
    )
    .all(sessionId)

export const openWorkflowQuestionCountForSession = (
  database: Database,
  sessionId: string,
): number =>
  database
    .query<{ count: number }, [string]>(
      `SELECT COUNT(*) count FROM question q JOIN workflow_cursor c
       ON c.record_id=q.workflow_cursor_record_id WHERE c.session_id=? AND ${questionOpenSql('q')}`,
    )
    .get(sessionId)!.count

export const workflowInboxQuestions = (database: Database): TaskFlowInboxQuestionRow[] =>
  database
    .query<TaskFlowInboxQuestionRow, []>(
      `SELECT q.number,q.record_id,q.asked_at,q.question,c.number cursor_record_id,c.project,c.project_record_id,c.workflow_slug,c.mode_slug,c.args,
              c.ordinal,c.step_slug,c.session_id
         FROM question q JOIN workflow_cursor c ON c.record_id=q.workflow_cursor_record_id
        WHERE c.state='awaiting-ruling' AND ${questionOpenSql('q')}
        ORDER BY q.asked_at,q.number`,
    )
    .all()

export function rulingRows(
  database: Database,
  input: {
    kind: 'workflow' | 'run' | 'all'
    since?: string
    after: number | null
    cursor: number | null
  },
): TaskFlowRulingRow[] {
  const clauses: string[] = []
  const values: string[] = []
  if (input.kind === 'workflow') clauses.push('q.workflow_cursor_record_id IS NOT NULL')
  else if (input.kind === 'run') clauses.push('q.run_record_id IS NOT NULL')
  if (input.since) {
    clauses.push(
      `(${questionOpenSql('q')} OR q.asked_at>=? OR q.answered_at>=? OR q.closed_at>=? OR q.overturned_at>=? OR q.filed_at>=?)`,
    )
    values.push(input.since, input.since, input.since, input.since, input.since)
  }
  if (input.after !== null) {
    clauses.push('q.change_seq>? AND q.change_seq<=?')
    values.push(String(input.after), String(input.cursor))
  }
  return database
    .query<TaskFlowRulingRow, string[]>(
      `SELECT q.number,q.record_id,q.run_record_id,r.number AS run_number,
              q.workflow_cursor_record_id workflow_cursor_id,q.workflow_key,
              COALESCE(r.repo,c.project) project,c.workflow_slug,c.mode_slug,
              COALESCE(r.session_id,c.session_id) session_id,
              q.asked_at,q.question,q.answer,q.answer_basis,q.answered_at,
              q.answered_by,q.answered_by_name,q.asked_via,
              q.answerer_kind,q.answer_channel,q.closed_at,q.close_reason,
              q.overturned_at,q.overturned_by,q.overturned_by_name,q.overturn_reason,q.replacement,
              q.filed_as,q.filed_ref,q.filed_record_id,q.filed_label,q.filed_at
         FROM question q LEFT JOIN run r ON r.record_id=q.run_record_id
         LEFT JOIN workflow_cursor c ON c.record_id=q.workflow_cursor_record_id
        ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY q.number`,
    )
    .all(...values)
}

export const rulingFileQuestion = (
  database: Database,
  questionId: string,
): TaskFlowRulingFileRow | null =>
  database
    .query<TaskFlowRulingFileRow, [string]>(
      `SELECT q.number,q.record_id,q.run_record_id,r.record_id run_record_id,COALESCE(r.parent_run_record_id,r.record_id) root_id,
              q.workflow_cursor_record_id,c.number workflow_cursor_number,c.workflow_slug,c.mode_slug,c.session_id workflow_owner,
              c.updated_at workflow_updated_at,
              q.question, q.answer, q.answer_basis,
              q.answered_at, q.answered_by, q.answered_by_name, q.answerer_kind,
              q.overturned_at, q.overturned_by, q.overturned_by_name,
              q.replacement, q.filed_as, q.filed_ref, q.filed_record_id, q.filed_label, q.filed_at,
              COALESCE(r.repo,c.project) repo, COALESCE(r.cwd,p.path) cwd,c.args,
              ${questionTaskHolderSql('q', 'r')} launch_key,p.path project_path
         FROM question q LEFT JOIN run r ON r.record_id = q.run_record_id
         LEFT JOIN workflow_cursor c ON c.record_id=q.workflow_cursor_record_id
         LEFT JOIN project p ON p.record_id=c.project_record_id AND p.retired_at IS NULL
         WHERE q.record_id=?`,
    )
    .get(questionId)

export const questionOutboxRow = (
  database: Database,
  questionId: string,
): TaskFlowQuestionOutboxRow | null =>
  database
    .query<TaskFlowQuestionOutboxRow, [string]>(
      `SELECT q.*, r.record_id AS run_record_id,
              COALESCE(run_project.name, cursor.project) AS project_name,
              COALESCE(run_project.record_id, cursor_project.record_id) AS project_record_id
         FROM question q
         LEFT JOIN run r ON r.record_id=q.run_record_id
         LEFT JOIN project run_project ON run_project.record_id=r.project_record_id
         LEFT JOIN workflow_cursor cursor ON cursor.record_id=q.workflow_cursor_record_id
         LEFT JOIN project cursor_project ON cursor_project.record_id=cursor.project_record_id
        WHERE q.record_id=?`,
    )
    .get(questionId)

export const questionCloseFacts = (
  database: Database,
  questionId: string,
): TaskFlowQuestionCloseRow | null =>
  database
    .query<TaskFlowQuestionCloseRow, [string]>(
      `SELECT q.answered_at,q.closed_at,q.run_record_id,q.workflow_cursor_record_id,c.state cursor_state,
              COALESCE(owner.parent_run_record_id,owner.record_id) root_id,
              (SELECT latest.status FROM run latest
                WHERE latest.record_id=COALESCE(owner.parent_run_record_id,owner.record_id)
                   OR latest.parent_run_record_id=COALESCE(owner.parent_run_record_id,owner.record_id)
                ORDER BY latest.turn DESC,latest.number DESC LIMIT 1) latest_status
         FROM question q
         LEFT JOIN run owner ON owner.record_id=q.run_record_id
         LEFT JOIN workflow_cursor c ON c.record_id=q.workflow_cursor_record_id
        WHERE q.record_id=?`,
    )
    .get(questionId)

export const overturnRulingRow = (
  database: Database,
  questionId: string,
): TaskFlowOverturnRulingRow | null =>
  database
    .query<TaskFlowOverturnRulingRow, [string]>(
      `SELECT q.number,q.record_id,q.run_record_id,COALESCE(owner.parent_run_record_id,owner.record_id) root_id,
              q.workflow_cursor_record_id,c.session_id workflow_owner,c.updated_at workflow_updated_at,
              q.answered_at,q.overturned_at,q.overturned_by,q.overturned_by_name,q.overturn_reason,q.replacement
         FROM question q LEFT JOIN run owner ON owner.record_id=q.run_record_id
         LEFT JOIN workflow_cursor c ON c.record_id=q.workflow_cursor_record_id WHERE q.record_id=?`,
    )
    .get(questionId)

export const unlinkedWorkflowQuestionIds = (
  database: Database,
  project: string,
  workflowKey: string,
): string[] =>
  database
    .query<{ record_id: string }, [string, string]>(
      `SELECT q.record_id FROM question q
       JOIN workflow_cursor c ON c.record_id=q.workflow_cursor_record_id
       WHERE c.project_record_id=(SELECT record_id FROM project WHERE name=?)
         AND q.workflow_key=? AND q.workflow_task_record_id IS NULL`,
    )
    .all(project, workflowKey)
    .map((row) => row.record_id)

export const pendingTaskLinks = (
  database: Database,
  table: 'workflow_cursor' | 'question',
): TaskFlowPendingTaskLinkRow[] =>
  table === 'workflow_cursor'
    ? database
        .query<TaskFlowPendingTaskLinkRow, []>(
          `SELECT c.record_id id,c.workflow_key task_key,p.name project
           FROM workflow_cursor c JOIN project p ON p.record_id=c.project_record_id
           WHERE c.task_record_id IS NULL AND c.workflow_key<>''`,
        )
        .all()
    : database
        .query<TaskFlowPendingTaskLinkRow, []>(
          `SELECT q.record_id id,q.workflow_key task_key,p.name project
           FROM question q JOIN workflow_cursor c ON c.record_id=q.workflow_cursor_record_id
           JOIN project p ON p.record_id=c.project_record_id
           WHERE q.workflow_task_record_id IS NULL AND q.workflow_key IS NOT NULL`,
        )
        .all()

export const linkedTaskReferences = (
  database: Database,
  table: 'workflow_cursor' | 'question',
): TaskFlowLinkedTaskReferenceRow[] =>
  table === 'workflow_cursor'
    ? database
        .query<TaskFlowLinkedTaskReferenceRow, []>(
          `SELECT c.task_record_id,p.name project FROM workflow_cursor c
           JOIN project p ON p.record_id=c.project_record_id WHERE c.task_record_id IS NOT NULL`,
        )
        .all()
    : database
        .query<TaskFlowLinkedTaskReferenceRow, []>(
          `SELECT q.workflow_task_record_id task_record_id,p.name project
           FROM question q JOIN workflow_cursor c ON c.record_id=q.workflow_cursor_record_id
           JOIN project p ON p.record_id=c.project_record_id
           WHERE q.workflow_task_record_id IS NOT NULL`,
        )
        .all()

export const renameStageProject = (
  database: Database,
  currentName: string,
  nextName: string,
): void => {
  database.query('UPDATE workflow_cursor SET project=? WHERE project=?').run(nextName, currentName)
}

export const taskRulingRows = (
  database: Database,
  project: string,
  taskRecordId: string,
  limit: number,
): TaskFlowTaskRulingRow[] =>
  database
    .query<TaskFlowTaskRulingRow, [string, string, string, string, number]>(
      `WITH raw_candidates AS (
         SELECT q.number question_id,q.record_id question_record_id,root.record_id run_record_id,NULL workflow_cursor_record_id,
                q.question, q.answer, q.answer_basis, q.answered_at,
                q.answerer_kind, q.answered_by_name, q.overturned_at, q.overturned_by_name, q.replacement,
                COALESCE(q.overturned_at,q.answered_at) effective_at
           FROM question q
           JOIN run owner ON owner.record_id=q.run_record_id
           JOIN run root ON root.record_id=COALESCE(owner.parent_run_record_id,owner.record_id)
          WHERE root.project_record_id=(SELECT record_id FROM project WHERE name=?)
            AND root.task_record_id=?
            AND q.answered_at IS NOT NULL
            AND NOT (q.overturned_at IS NOT NULL AND q.replacement IS NULL)
         UNION ALL
         SELECT q.number question_id,q.record_id question_record_id,NULL run_record_id,q.workflow_cursor_record_id,
                q.question, q.answer, q.answer_basis, q.answered_at,
                q.answerer_kind, q.answered_by_name, q.overturned_at, q.overturned_by_name, q.replacement,
                COALESCE(q.overturned_at,q.answered_at) effective_at
           FROM question q
           JOIN workflow_cursor c ON c.record_id=q.workflow_cursor_record_id
          WHERE c.project_record_id=(SELECT record_id FROM project WHERE name=?)
            AND q.workflow_task_record_id=?
            AND q.answered_at IS NOT NULL
            AND NOT (q.overturned_at IS NOT NULL AND q.replacement IS NULL)
       ), candidates AS (
         SELECT *, COUNT(*) OVER () candidate_count FROM raw_candidates
       )
       SELECT question_id,question_record_id,run_record_id,workflow_cursor_record_id,question,answer,answer_basis,answered_at,answerer_kind,
              answered_by_name,overturned_at,overturned_by_name,replacement,candidate_count
         FROM candidates
        ORDER BY effective_at DESC, question_id DESC
        LIMIT ?`,
    )
    .all(project, taskRecordId, project, taskRecordId, limit)

export const localQuestionProjects = (database: Database): Array<{ project: string | null }> =>
  database
    .query<{ project: string | null }, []>(
      `SELECT COALESCE(run_project.name,cursor.project) AS project
       FROM question q
       LEFT JOIN run r ON r.record_id=q.run_record_id
       LEFT JOIN project run_project ON run_project.record_id=r.project_record_id
       LEFT JOIN workflow_cursor cursor ON cursor.record_id=q.workflow_cursor_record_id
      WHERE q.run_record_id IS NULL OR EXISTS (
        SELECT 1 FROM outbox o
         WHERE o.kind='run' AND o.row_id=r.record_id AND o.synced_at IS NOT NULL
      )`,
    )
    .all()
