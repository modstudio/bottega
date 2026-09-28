// concern: question-outbox
/** Knows how local question evidence becomes an ordered hosted-record mutation. Must not know Postgres. */
import type { Database } from 'bun:sqlite'
import { newRecordId, PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { nowIso } from '../database/db.ts'

export const WITHHELD_SECRET_SHAPED = '[withheld: secret-shaped content]'

export const QUESTION_RECORD_PAYLOAD_COLUMNS = [
  'id',
  'spaceId',
  'runId',
  'workflowKey',
  'workflowCursorId',
  'projectName',
  'machineId',
  'localId',
  'revision',
  'askedAt',
  'question',
  'options',
  'recommendation',
  'why',
  'askedVia',
  'answer',
  'answeredAt',
  'answeredBy',
  'answererKind',
  'answerChannel',
  'awaitingOperatorAt',
  'relayedBy',
  'overturnedAt',
  'overturnedBy',
  'overturnReason',
  'replacement',
  'filedAs',
  'filedRef',
  'filedAt',
  'closedAt',
  'closeReason',
  'withheldFields',
  'audits',
  'createdAt',
  'updatedAt',
] as const
export const QUESTION_RECORD_PAYLOAD_CONTRACT = {
  columns: QUESTION_RECORD_PAYLOAD_COLUMNS,
  laterAdded: {},
} as const

type QuestionRow = Record<string, unknown> & {
  id: number
  record_id: string | null
  run_id: number | null
  run_record_id: string | null
  project_name: string | null
}

const json = (value: unknown): unknown => (value == null ? null : JSON.parse(String(value)))

function localMachineId(database: Database): string {
  const existing = database
    .query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key='machine_id'")
    .get()
  if (existing) return existing.value
  const id = newRecordId()
  database.query("INSERT INTO schema_meta (key,value) VALUES ('machine_id',?)").run(id)
  return id
}

function loadQuestion(database: Database, questionId: number): QuestionRow {
  const row = database
    .query<QuestionRow, [number]>(
      `SELECT q.*, r.record_id AS run_record_id,
              COALESCE(run_project.name, cursor.project) AS project_name
         FROM question q
         LEFT JOIN run r ON r.id=q.run_id
         LEFT JOIN project run_project ON run_project.id=r.project_id
         LEFT JOIN workflow_cursor cursor ON cursor.id=q.workflow_cursor_id
        WHERE q.id=?`,
    )
    .get(questionId)
  if (!row) throw new Error(`question ${questionId} does not exist and cannot be enqueued`)
  if (!row.record_id) {
    row.record_id = newRecordId()
    database.query('UPDATE question SET record_id=? WHERE id=?').run(row.record_id, row.id)
  }
  return row
}

function withheldValue(field: string, value: unknown, withheldFields: string[]): unknown {
  if (value == null) return value
  const texts = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [String(value)]
  if (!texts.some(containsSecretShaped)) return value
  withheldFields.push(field)
  return WITHHELD_SECRET_SHAPED
}

/** Returns false while a parent run has no hosted identity. */
export function enqueueQuestionRecord(database: Database, questionId: number): boolean {
  const row = loadQuestion(database, questionId)
  if (row.run_id !== null && row.run_record_id === null) return false
  const recordId = row.record_id!
  const at = nowIso()
  const withheldFields: string[] = []
  const audits = database
    .query<Record<string, unknown>, [number]>(
      `SELECT action,actor_session,at,reason FROM question_mutation_audit
       WHERE question_id=? ORDER BY at,action`,
    )
    .all(questionId)
    .map((audit) => ({
      action: audit.action,
      actorSession: audit.actor_session,
      at: audit.at,
      reason: withheldValue('audit_reason', audit.reason, withheldFields),
    }))
  const payload = {
    id: recordId,
    spaceId: PLATFORM_SPACE_ID,
    runId: row.run_record_id,
    workflowKey: row.workflow_key,
    workflowCursorId: row.workflow_cursor_id,
    projectName: row.project_name,
    machineId: localMachineId(database),
    localId: row.id,
    revision: row.revision,
    askedAt: row.asked_at,
    question: withheldValue('question', row.question, withheldFields),
    options: withheldValue('options', json(row.options), withheldFields),
    recommendation: withheldValue('recommendation', row.recommendation, withheldFields),
    why: withheldValue('why', row.why, withheldFields),
    askedVia: row.asked_via,
    answer: withheldValue('answer', row.answer, withheldFields),
    answeredAt: row.answered_at,
    answeredBy: row.answered_by,
    answererKind: row.answerer_kind,
    answerChannel: row.answer_channel,
    awaitingOperatorAt: row.awaiting_operator_at,
    relayedBy: row.relayed_by,
    overturnedAt: row.overturned_at,
    overturnedBy: row.overturned_by,
    overturnReason: withheldValue('overturn_reason', row.overturn_reason, withheldFields),
    replacement: withheldValue('replacement', row.replacement, withheldFields),
    filedAs: row.filed_as,
    filedRef: withheldValue('filed_ref', row.filed_ref, withheldFields),
    filedAt: row.filed_at,
    closedAt: row.closed_at,
    closeReason: row.close_reason,
    withheldFields: [...new Set(withheldFields)],
    audits,
    createdAt: row.asked_at,
    updatedAt: at,
  }
  const pending = database
    .query<{ id: number }, [string]>(
      `SELECT id FROM outbox
        WHERE kind='question' AND record_id=? AND synced_at IS NULL
          AND quarantined_at IS NULL AND retired_at IS NULL
        ORDER BY id LIMIT 1`,
    )
    .get(recordId)
  if (pending) {
    database
      .query('UPDATE outbox SET payload=?,created_at=?,attempts=0,last_error=NULL WHERE id=?')
      .run(JSON.stringify(payload), at, pending.id)
    return true
  }
  database
    .query("INSERT INTO outbox (kind,record_id,payload,created_at) VALUES ('question',?,?,?)")
    .run(recordId, JSON.stringify(payload), at)
  return true
}

export function backfillQuestionRecords(database: Database): { minted: number; enqueued: number } {
  const missing = database
    .query<{ id: number }, []>('SELECT id FROM question WHERE record_id IS NULL')
    .all()
  for (const row of missing)
    database.query('UPDATE question SET record_id=? WHERE id=?').run(newRecordId(), row.id)
  const questions = database
    .query<{ id: number }, []>(
      `SELECT id FROM question WHERE NOT EXISTS (
         SELECT 1 FROM outbox WHERE kind='question' AND record_id=question.record_id
       ) ORDER BY id`,
    )
    .all()
  for (const row of questions) enqueueQuestionRecord(database, row.id)
  return { minted: missing.length, enqueued: questions.length }
}
