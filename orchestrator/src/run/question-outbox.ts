// concern: question-outbox
/** Knows how local question evidence becomes an ordered hosted-record mutation. Must not know Postgres. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { nowIso } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'

import { insertOutboxRow, refreshPendingOutboxRow } from '../record/outbox-enqueue.ts'
import {
  RELEASED_OUTBOX_PAYLOAD,
  releasedOutboxPayloadSql,
} from '../record/outbox-prune-payload.ts'
import { stringifyOutboxPayload } from '../record/outbox-sanitize.ts'

type QuestionRow = Record<string, unknown> & {
  record_id: string
  number: number
  run_record_id: string | null
  project_name: string | null
  project_record_id: string | null
  workflow_cursor_record_id: string | null
  workflow_task_record_id: string | null
  answered_by_name: string | null
  overturned_by_name: string | null
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

function questionPayload(row: QuestionRow, audits: object[], at: string): string {
  return stringifyOutboxPayload('question', {
    id: row.record_id,
    number: row.number,
    spaceId: PLATFORM_SPACE_ID,
    runId: row.run_record_id,
    workflowKey: row.workflow_key,
    workflowTaskId: row.workflow_task_record_id,
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
    kind: row.kind,
    typedOptions: json(row.typed_options),
    criteria: json(row.criteria),
    levels: json(row.levels),
    answer: row.answer,
    answerValue: row.answer_value,
    answerBasis: row.answer_basis,
    answeredAt: row.answered_at,
    answeredBy: row.answered_by,
    answeredByName: row.answered_by_name,
    answeredByKind: row.answered_by_kind,
    answererKind: row.answerer_kind,
    answerChannel: row.answer_channel,
    jevPick: row.jev_pick,
    jevConfidence: row.jev_confidence,
    jevProbabilities: json(row.jev_probabilities),
    jevModel: row.jev_model,
    jevInputTokens: row.jev_input_tokens,
    jevError: row.jev_error,
    jevAgreed: row.jev_agreed,
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
  const payload = questionPayload(row, audits, at)
  const pending = database
    .query<{ id: number }, [string]>(
      `SELECT id FROM outbox
        WHERE kind='question' AND row_id=? AND synced_at IS NULL
          AND quarantined_at IS NULL AND retired_at IS NULL
        ORDER BY id LIMIT 1`,
    )
    .get(recordId)
  if (pending) {
    refreshPendingOutboxRow(database, { id: pending.id, payload, createdAt: at })
    return true
  }
  insertOutboxRow(database, {
    recordId: newRecordId(),
    kind: 'question',
    rowId: recordId,
    payload,
    createdAt: at,
  })
  return true
}

export function backfillQuestionRecords(database: Database): { enqueued: number } {
  const questions = database
    .query<{ record_id: string }, [string]>(
      `SELECT question.record_id FROM question
       LEFT JOIN outbox latest ON latest.id=(
         SELECT id FROM outbox
          WHERE kind='question' AND row_id=question.record_id
          ORDER BY id DESC LIMIT 1
       )
       WHERE CASE
         WHEN ${releasedOutboxPayloadSql('latest.payload')} THEN question.number
         ELSE COALESCE(json_extract(latest.payload, '$.number'), -1)
       END != question.number
       ORDER BY question.number`,
    )
    .all(RELEASED_OUTBOX_PAYLOAD)
  for (const row of questions) enqueueQuestionRecord(database, row.record_id)
  return { enqueued: questions.length }
}
