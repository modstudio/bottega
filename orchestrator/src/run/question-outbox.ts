// concern: question-outbox
/** Knows how local question evidence becomes an ordered hosted-record mutation. Must not know Postgres. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { nowIso } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'

import { stringifyOutboxPayload } from '../record/outbox-sanitize.ts'

type QuestionRow = Record<string, unknown> & {
  record_id: string
  number: number
  run_record_id: string | null
  project_name: string | null
  project_record_id: string | null
  workflow_cursor_record_id: string | null
}

const json = (value: unknown): unknown => (value == null ? null : JSON.parse(String(value)))

function loadQuestion(database: Database, questionId: string): QuestionRow {
  const row = database
    .query<QuestionRow, [string]>(
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
  if (!row) throw new Error(`question ${questionId} does not exist and cannot be enqueued`)
  return row
}

export function enqueueQuestionRecord(database: Database, questionId: string): boolean {
  const row = loadQuestion(database, questionId)
  const recordId = row.record_id!
  const at = nowIso()
  const audits = database
    .query<Record<string, unknown>, [string]>(
      `SELECT action,actor_session,at,reason FROM question_mutation_audit
       WHERE question_record_id=? ORDER BY at,action`,
    )
    .all(questionId)
    .map((audit) => ({
      action: audit.action,
      actorSession: audit.actor_session,
      at: audit.at,
      reason: audit.reason,
    }))
  const payload = stringifyOutboxPayload('question', {
    id: recordId,
    spaceId: PLATFORM_SPACE_ID,
    runId: row.run_record_id,
    workflowKey: row.workflow_key,
    workflowCursorId: null,
    workflowCursorRecordId: row.workflow_cursor_record_id,
    projectId: row.project_record_id,
    projectName: row.project_name,
    machineId: machineId(),
    localId: row.number,
    revision: row.revision,
    askedAt: row.asked_at,
    question: row.question,
    options: json(row.options),
    recommendation: row.recommendation,
    why: row.why,
    askedVia: row.asked_via,
    answer: row.answer,
    answerBasis: row.answer_basis,
    answeredAt: row.answered_at,
    answeredBy: row.answered_by,
    answeredByName: row.answered_by_name,
    answererKind: row.answerer_kind,
    answerChannel: row.answer_channel,
    awaitingOperatorAt: row.awaiting_operator_at,
    relayedBy: row.relayed_by,
    overturnedAt: row.overturned_at,
    overturnedBy: row.overturned_by,
    overturnedByName: row.overturned_by_name,
    overturnReason: row.overturn_reason,
    replacement: row.replacement,
    filedAs: row.filed_as,
    filedRef: row.filed_ref,
    filedRecordId: row.filed_record_id,
    filedLabel: row.filed_label,
    filedAt: row.filed_at,
    closedAt: row.closed_at,
    closeReason: row.close_reason,
    audits,
    createdAt: row.asked_at,
    updatedAt: at,
  })
  const pending = database
    .query<{ id: number }, [string]>(
      `SELECT id FROM outbox
        WHERE kind='question' AND row_id=? AND synced_at IS NULL
          AND quarantined_at IS NULL AND retired_at IS NULL
        ORDER BY id LIMIT 1`,
    )
    .get(recordId)
  if (pending) {
    database
      .query('UPDATE outbox SET payload=?,created_at=?,attempts=0,last_error=NULL WHERE id=?')
      .run(payload, at, pending.id)
    return true
  }
  database
    .query(
      "INSERT INTO outbox (record_id,kind,row_id,payload,created_at) VALUES (?,'question',?,?,?)",
    )
    .run(newRecordId(), recordId, payload, at)
  return true
}

export function backfillQuestionRecords(database: Database): { enqueued: number } {
  const questions = database
    .query<{ record_id: string }, []>(
      `SELECT record_id FROM question WHERE NOT EXISTS (
         SELECT 1 FROM outbox WHERE kind='question' AND row_id=question.record_id
       ) ORDER BY number`,
    )
    .all()
  for (const row of questions) enqueueQuestionRecord(database, row.record_id)
  return { enqueued: questions.length }
}
