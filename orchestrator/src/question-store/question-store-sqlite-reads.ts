// concern: SQLite task-flow reads joined to local questions
/** Carries the unchanged cross-table reads used before questions move to the record. */

import type { Database } from 'bun:sqlite'
import { SESSION_LIVE_MS } from '../../../shared/session-liveness.ts'
import { voidedSql } from '../evidence/evidence-query.ts'
import type {
  TaskFlowCloseOutStageRow,
  TaskFlowCursorLifecycleRow,
  TaskFlowCursorWorkRow,
  TaskFlowInboxQuestionRow,
  TaskFlowKeylessSessionCursorRow,
  TaskFlowLinkedTaskReferenceRow,
  TaskFlowOpenSessionStageRow,
  TaskFlowOverturnRulingRow,
  TaskFlowPendingTaskLinkRow,
  TaskFlowQuestionCloseRow,
  TaskFlowRulingFileRow,
  TaskFlowRulingRow,
  TaskFlowTaskRulingRow,
  TaskFlowWaitingQuestionRow,
} from '../workflow/task-flow-store-types.ts'
import { questionOpenSql, questionTaskHolderSql } from './question-store-sql.ts'

export function questionNumberProjectIds(database: Database, number: number): string[] {
  return database
    .query<{ project_record_id: string | null }, [number]>(
      `SELECT DISTINCT COALESCE(owner.project_record_id,cursor.project_record_id) project_record_id
       FROM question q LEFT JOIN run owner ON owner.record_id=q.run_record_id
       LEFT JOIN workflow_cursor cursor ON cursor.record_id=q.workflow_cursor_record_id
       WHERE q.number=?`,
    )
    .all(number)
    .flatMap((row) => (row.project_record_id ? [row.project_record_id] : []))
}

export type QueriedInboxQuestion = {
  number: number
  record_id: string
  run_record_id: string
  run_number: number
  asked_at: string
  question: string
  answered_at: string | null
  overturned_at: string | null
  overturned_by: string | null
  overturn_reason: string | null
  replacement: string | null
  filed_as: 'doc' | 'canon-proposal' | null
  filed_ref: string | null
  filed_record_id: string | null
  filed_label: string | null
  filed_at: string | null
  options: string | null
  recommendation: string | null
  why: string | null
  kind: 'choice' | 'yesno' | 'score' | 'text'
  jev_pick: string | null
  jev_confidence: number | null
  jev_probabilities: string | null
  jev_error: string | null
  agent: string
  job: string
  repo: string | null
  task_key: string | null
  project_record_id: string | null
  status: string
  session_id: string | null
  awaiting_operator_at: string | null
  root_status: string
  root_voided: number
  root_id: string
  root_number: number
  root_record_id: string
  session_recent: number
}

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
      `SELECT record_id,number,project,workflow_slug,mode_slug,workflow_key,state,updated_at,
        (SELECT q.record_id FROM question q
          WHERE q.workflow_cursor_record_id=workflow_cursor.record_id
            AND ${questionOpenSql('q')} LIMIT 1) open_question_record_id
       FROM workflow_cursor
        WHERE session_id=? AND state NOT IN ('done','abandoned') ORDER BY number`,
    )
    .all(sessionId)

export const keylessSessionCursors = (
  database: Database,
  project: string | null,
): TaskFlowKeylessSessionCursorRow[] => {
  const projectClause = project ? 'AND c.project=?' : ''
  return database
    .query<TaskFlowKeylessSessionCursorRow, string[]>(
      `SELECT c.record_id,c.number,c.project,c.workflow_slug,c.step_slug,c.session_id,c.updated_at,
        (SELECT q.record_id FROM question q WHERE q.workflow_cursor_record_id=c.record_id
          AND ${questionOpenSql('q')} LIMIT 1) open_question_record_id
       FROM workflow_cursor c WHERE c.workflow_key='' AND c.session_id IS NOT NULL
         AND c.state NOT IN ('done','abandoned') ${projectClause} ORDER BY c.number`,
    )
    .all(...(project ? [project] : []))
}

export const workflowInboxQuestions = (
  database: Database,
  limit?: number,
  offset = 0,
): TaskFlowInboxQuestionRow[] =>
  database
    .query<TaskFlowInboxQuestionRow, [number, number]>(
      `SELECT q.number,q.record_id,q.asked_at,q.question,c.number cursor_record_id,c.project,c.project_record_id,c.workflow_slug,c.mode_slug,c.args,
              COALESCE(q.workflow_step_ordinal - 1,c.ordinal) ordinal,
              COALESCE(q.workflow_step_slug,c.step_slug) step_slug,c.session_id
         FROM question q JOIN workflow_cursor c ON c.record_id=q.workflow_cursor_record_id
        WHERE c.state='awaiting-ruling' AND ${questionOpenSql('q')}
        ORDER BY q.asked_at,q.number LIMIT ? OFFSET ?`,
    )
    .all(limit ?? -1, offset)

export function runInboxQuestionRows(
  database: Database,
  cutoff = new Date(Date.now() - SESSION_LIVE_MS).toISOString(),
  limit?: number,
  offset = 0,
): QueriedInboxQuestion[] {
  return database
    .query(
      `SELECT q.number,q.record_id,q.run_record_id,r.number AS run_number,
            q.asked_at,q.question,q.options,q.recommendation,q.why,q.kind,
            q.jev_pick,q.jev_confidence,q.jev_probabilities,q.jev_error,
            q.answered_at,q.overturned_at,q.overturned_by,q.overturn_reason,q.replacement,
            q.filed_as,q.filed_ref,q.filed_record_id,q.filed_label,q.filed_at,
            r.agent,r.job,r.repo,COALESCE(r.launch_key,root.launch_key) task_key,
            root.project_record_id,r.status,r.session_id,q.awaiting_operator_at,
            root.status root_status,root.record_id root_record_id,root.number root_number,
            ${voidedSql('root')} root_voided,
            COALESCE(r.parent_run_record_id,r.record_id) root_id,
            CASE WHEN r.session_id IS NOT NULL AND seen.last_seen>=? THEN 1 ELSE 0 END session_recent
       FROM question q JOIN run r ON r.record_id=q.run_record_id
       JOIN run root ON root.record_id=COALESCE(r.parent_run_record_id,r.record_id)
       LEFT JOIN session_seen seen ON seen.session_id=r.session_id
      WHERE ${questionOpenSql('q')}
      ORDER BY q.run_record_id,q.number LIMIT ? OFFSET ?`,
    )
    .all(cutoff, limit ?? -1, offset) as QueriedInboxQuestion[]
}

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
              q.workflow_cursor_record_id workflow_cursor_id,q.workflow_key,q.workflow_task_record_id,
              COALESCE(r.repo,c.project) project,c.workflow_slug,c.mode_slug,
              COALESCE(r.session_id,c.session_id) session_id,
              q.asked_at,q.question,q.answer,q.answer_basis,q.answered_at,q.kind,q.jev_model,q.jev_pick,
              q.jev_probabilities,q.jev_agreed,q.jev_question_version,q.jev_fits,q.jev_order_flipped,
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

const QUESTION_PORT_COLUMNS = `q.*,owner.number run_number,owner.record_id owner_id,
  owner.status owner_status,owner.pid owner_pid,
  COALESCE(owner.parent_run_record_id,owner.record_id) root_id,
  cursor.number workflow_cursor_number,cursor.workflow_slug,cursor.mode_slug,
  cursor.session_id workflow_owner,cursor.updated_at workflow_updated_at,cursor.state cursor_state,
  cursor.args,COALESCE(owner.repo,cursor.project) repo,COALESCE(owner.cwd,project.path) cwd,
  project.path project_path,
  ${questionTaskHolderSql('q', 'owner')} launch_key,
  ${questionTaskHolderSql('q', 'owner')} taskHolder,
  (SELECT latest.status FROM run latest
    WHERE latest.record_id=COALESCE(owner.parent_run_record_id,owner.record_id)
       OR latest.parent_run_record_id=COALESCE(owner.parent_run_record_id,owner.record_id)
    ORDER BY latest.turn DESC,latest.number DESC LIMIT 1) latest_status,
  COALESCE(run_project.name,cursor.project) project_name,
  COALESCE(run_project.record_id,project.record_id) project_record_id`

export const questionsByIdRows = (
  database: Database,
  ids: readonly string[],
): Record<string, unknown>[] => {
  if (ids.length === 0) return []
  return database
    .query(
      `SELECT ${QUESTION_PORT_COLUMNS} FROM question q
       LEFT JOIN run owner ON owner.record_id=q.run_record_id
       LEFT JOIN project run_project ON run_project.record_id=owner.project_record_id
       LEFT JOIN workflow_cursor cursor ON cursor.record_id=q.workflow_cursor_record_id
       LEFT JOIN project ON project.record_id=cursor.project_record_id
       WHERE q.record_id IN (${ids.map(() => '?').join(',')}) ORDER BY q.number`,
    )
    .all(...ids) as Record<string, unknown>[]
}

export const maxQuestionNumber = (database: Database): Array<{ number: number }> => [
  database
    .query<{ number: number }, []>('SELECT COALESCE(MAX(number),0) number FROM question')
    .get()!,
]

export const questionByNumberRow = (
  database: Database,
  number: number,
): Record<string, unknown>[] =>
  database
    .query(
      `SELECT ${QUESTION_PORT_COLUMNS} FROM question q
       LEFT JOIN run owner ON owner.record_id=q.run_record_id
       LEFT JOIN project run_project ON run_project.record_id=owner.project_record_id
       LEFT JOIN workflow_cursor cursor ON cursor.record_id=q.workflow_cursor_record_id
       LEFT JOIN project ON project.record_id=cursor.project_record_id
       WHERE q.number=?`,
    )
    .all(number) as Record<string, unknown>[]

export const openQuestionsForCursors = (
  database: Database,
  cursorIds: readonly string[],
): Array<{ workflow_cursor_record_id: string; number: number }> => {
  if (!cursorIds.length) return []
  return database
    .query<{ workflow_cursor_record_id: string; number: number }, string[]>(
      `SELECT workflow_cursor_record_id,MIN(number) number FROM question
       WHERE workflow_cursor_record_id IN (${cursorIds.map(() => '?').join(',')})
         AND answered_at IS NULL AND closed_at IS NULL
       GROUP BY workflow_cursor_record_id ORDER BY number`,
    )
    .all(...cursorIds)
}

function filteredQuestionRows(database: Database, predicate: string, values: string[]) {
  return database
    .query(
      `SELECT ${QUESTION_PORT_COLUMNS} FROM question q
       LEFT JOIN run owner ON owner.record_id=q.run_record_id
       LEFT JOIN project run_project ON run_project.record_id=owner.project_record_id
       LEFT JOIN workflow_cursor cursor ON cursor.record_id=q.workflow_cursor_record_id
       LEFT JOIN project ON project.record_id=cursor.project_record_id
       WHERE ${predicate} ORDER BY q.number`,
    )
    .all(...values) as Record<string, unknown>[]
}

export const openQuestionsForTasks = (database: Database, taskIds: readonly string[]) =>
  taskIds.length
    ? filteredQuestionRows(
        database,
        `q.workflow_task_record_id IN (${taskIds.map(() => '?').join(',')})
         AND q.answered_at IS NULL AND q.closed_at IS NULL`,
        [...taskIds],
      )
    : []

export const questionsForSession = (database: Database, sessionId: string) =>
  filteredQuestionRows(database, 'COALESCE(owner.session_id,cursor.session_id)=?', [sessionId])

export const unlinkedWorkflowQuestions = (
  database: Database,
  project?: string,
  workflowKey?: string,
) => {
  const clauses = [
    'q.workflow_cursor_record_id IS NOT NULL',
    'q.workflow_key IS NOT NULL',
    'q.workflow_task_record_id IS NULL',
  ]
  const values: string[] = []
  if (project) {
    clauses.push('project.name=?')
    values.push(project)
  }
  if (workflowKey) {
    clauses.push('q.workflow_key=?')
    values.push(workflowKey)
  }
  return filteredQuestionRows(database, clauses.join(' AND '), values)
}

export const questionsForCursor = (
  database: Database,
  workflowCursorRecordId: string,
): Record<string, unknown>[] =>
  database
    .query(
      `SELECT ${QUESTION_PORT_COLUMNS} FROM question q
       LEFT JOIN run owner ON owner.record_id=q.run_record_id
       LEFT JOIN project run_project ON run_project.record_id=owner.project_record_id
       LEFT JOIN workflow_cursor cursor ON cursor.record_id=q.workflow_cursor_record_id
       LEFT JOIN project ON project.record_id=cursor.project_record_id
       WHERE q.workflow_cursor_record_id=? ORDER BY q.number`,
    )
    .all(workflowCursorRecordId) as Record<string, unknown>[]

export const ruleAuditReasons = (
  database: Database,
  workflowCursorRecordId: string,
  actorSession: string,
): Array<{ reason: string | null }> =>
  database
    .query<{ reason: string | null }, [string, string]>(
      `SELECT audit.reason FROM question_mutation_audit audit
       JOIN question q ON q.record_id=audit.question_record_id
       WHERE q.workflow_cursor_record_id=? AND audit.action='rule' AND audit.actor_session=?
       ORDER BY audit.at,audit.record_id`,
    )
    .all(workflowCursorRecordId, actorSession)

export const questionsForRun = (database: Database, runId: string): Record<string, unknown>[] =>
  database
    .query(
      `SELECT ${QUESTION_PORT_COLUMNS} FROM question q
       LEFT JOIN run owner ON owner.record_id=q.run_record_id
       LEFT JOIN project run_project ON run_project.record_id=owner.project_record_id
       LEFT JOIN workflow_cursor cursor ON cursor.record_id=q.workflow_cursor_record_id
       LEFT JOIN project ON project.record_id=cursor.project_record_id
       WHERE q.run_record_id=? ORDER BY q.number`,
    )
    .all(runId) as Record<string, unknown>[]

export const questionsForRuns = (
  database: Database,
  runIds: readonly string[],
): Record<string, unknown>[] => {
  if (!runIds.length) return []
  return filteredQuestionRows(database, `q.run_record_id IN (${runIds.map(() => '?').join(',')})`, [
    ...runIds,
  ])
}
