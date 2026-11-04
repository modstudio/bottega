// concern: typed-question-report
/** Reports hub-owned typed-question evidence joined to observed outcomes. */

import type { Database } from 'bun:sqlite'
import { noulProbability } from '../../shared/typed-question/client.ts'
import {
  type TypedQuestionMetricRow,
  typedQuestionMetrics,
} from '../../shared/typed-question/typed-question-metrics.ts'
import type { TypedQuestionReportBlock } from '../../shared/typed-question/typed-question-render.ts'
import { db } from './db.ts'
import { NOTE_DUPLICATE_QUESTION, noteDuplicateLabel } from './note-duplicate-question.ts'

type AnswerRow = {
  question_id: string
  question_version: number
  subject_ref: string
  answer_json: string | null
  input_tokens: number | null
  latency_ms: number
  error: string | null
}

export function hubTypedQuestionReport(
  options: { days?: number },
  database: Database = db(),
): TypedQuestionReportBlock[] {
  const rows = database
    .query(
      `SELECT question_id,question_version,subject_ref,answer_json,input_tokens,latency_ms,error
       FROM typed_question_answer
       ${options.days === undefined ? '' : "WHERE datetime(created_at) >= datetime('now', '-' || ? || ' days')"}
       ORDER BY question_id,question_version,created_at`,
    )
    .all(...(options.days === undefined ? [] : [options.days])) as AnswerRow[]
  const groups = Map.groupBy(rows, (row) => `${row.question_id}\0${row.question_version}`)
  return [...groups.values()].map((answers) => {
    const first = answers[0]!
    const labeler = first.question_id === NOTE_DUPLICATE_QUESTION.id ? noteDuplicateLabel : null
    const metricRows: TypedQuestionMetricRow[] = answers.map((answer) => ({
      probability: answer.answer_json === null ? null : noulProbability(answer.answer_json),
      label: labeler ? labeler(database, answer.subject_ref) : null,
      error: answer.error,
      latencyMs: answer.latency_ms,
      inputTokens: answer.input_tokens,
    }))
    const current =
      first.question_id === NOTE_DUPLICATE_QUESTION.id &&
      first.question_version === NOTE_DUPLICATE_QUESTION.version
    const threshold = current ? NOTE_DUPLICATE_QUESTION.threshold : null
    const metrics = typedQuestionMetrics(metricRows, threshold)
    return {
      questionId: first.question_id,
      questionVersion: first.question_version,
      threshold,
      ...metrics,
      labeled: labeler ? metrics.labeled : null,
      pending: labeler ? metrics.pending : null,
      baseRate: labeler ? metrics.baseRate : null,
      auc: labeler ? metrics.auc : null,
    }
  })
}
