// concern: typed-question-answer-store
/** Persists local typed-question evidence without interpreting it. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso } from '../database/db.ts'

export type TypedQuestionAnswerRow = {
  questionId: string
  questionVersion: number
  subjectKind: string
  subjectRef: string
  stateSha: string
  answerJson: string | null
  model: string | null
  inputTokens: number | null
  latencyMs: number
  error: string | null
}

export function recordTypedQuestionAnswer(
  row: TypedQuestionAnswerRow,
  database: Database = db(true),
): void {
  database
    .query(
      `INSERT INTO typed_question_answer
       (record_id,question_id,question_version,subject_kind,subject_ref,state_sha,answer_json,
        model,input_tokens,latency_ms,error,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      newRecordId(),
      row.questionId,
      row.questionVersion,
      row.subjectKind,
      row.subjectRef,
      row.stateSha,
      row.answerJson,
      row.model,
      row.inputTokens,
      row.latencyMs,
      row.error,
      nowIso(),
    )
}
