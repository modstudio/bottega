// concern: typed-question-report
/** Reads typed-question evidence and joins question-specific outcomes. */

import type { Database } from 'bun:sqlite'
import type { TypedQuestionAnswer } from '../../../shared/typed-question/client.ts'
import { db } from '../database/db.ts'
import { TERMINAL_RUN_STATUS_SQL } from '../run/run-status.ts'
import { SPEC_UNSETTLED_QUESTION } from './spec-unsettled-question.ts'
import {
  type TypedQuestionMetricRow,
  type TypedQuestionMetrics,
  typedQuestionMetrics,
} from './typed-question-metrics.ts'

type AnswerRow = {
  question_id: string
  question_version: number
  subject_ref: string
  answer_json: string | null
  input_tokens: number | null
  latency_ms: number
  error: string | null
}

export type TypedQuestionReportBlock = Omit<TypedQuestionMetrics, 'labeled' | 'pending'> & {
  questionId: string
  questionVersion: number
  threshold: number | null
  labeled: number | null
  pending: number | null
}

const declarations = [SPEC_UNSETTLED_QUESTION] as const

/** The threshold of the current declaration for this exact version, or null. */
function declaredThreshold(questionId: string, questionVersion: number): number | null {
  const declared = declarations.find(
    (question) => question.id === questionId && question.version === questionVersion,
  )
  return declared ? declared.threshold : null
}

export function specUnsettledLabel(database: Database, subjectRef: string): boolean | null {
  const result = database
    .query(
      `WITH RECURSIVE matched_root(record_id) AS (
         SELECT record_id FROM run
          WHERE job='implement' AND parent_run_record_id IS NULL AND spec_sha=?
       ), chain(root_id,record_id,status) AS (
         SELECT record_id,record_id,status FROM run WHERE record_id IN matched_root
         UNION ALL
         SELECT chain.root_id,child.record_id,child.status FROM chain
         JOIN run child ON child.parent_run_record_id=chain.record_id
       )
       SELECT
         (SELECT COUNT(*) FROM matched_root) AS roots,
         EXISTS(SELECT 1 FROM question JOIN chain ON chain.record_id=question.run_record_id) AS asked,
         NOT EXISTS(SELECT 1 FROM chain WHERE status NOT IN ${TERMINAL_RUN_STATUS_SQL}) AS terminal`,
    )
    .get(subjectRef) as { roots: number; asked: number; terminal: number }
  if (result.asked) return true
  if (result.roots > 0 && result.terminal) return false
  return null
}

const labelers: Readonly<
  Record<string, (database: Database, subjectRef: string) => boolean | null>
> = { [SPEC_UNSETTLED_QUESTION.id]: specUnsettledLabel }

/** A noul answer's probability; a choice answer or an unreadable row carries none. */
function probability(answerJson: string | null): number | null {
  if (answerJson === null) return null
  let answer: TypedQuestionAnswer
  try {
    answer = JSON.parse(answerJson) as TypedQuestionAnswer
  } catch {
    return null
  }
  return 'noul' in answer && typeof answer.noul === 'number' ? answer.noul : null
}

export function typedQuestionReport(
  options: { question?: string; days?: number },
  database: Database = db(),
): TypedQuestionReportBlock[] {
  const clauses: string[] = []
  const parameters: (string | number)[] = []
  if (options.question) {
    clauses.push('question_id=?')
    parameters.push(options.question)
  }
  if (options.days !== undefined) {
    clauses.push("datetime(created_at) >= datetime('now', '-' || ? || ' days')")
    parameters.push(options.days)
  }
  const rows = database
    .query(
      `SELECT question_id,question_version,subject_ref,answer_json,input_tokens,latency_ms,error
       FROM typed_question_answer ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY question_id,question_version,created_at`,
    )
    .all(...parameters) as AnswerRow[]
  const groups = Map.groupBy(rows, (row) => `${row.question_id}\0${row.question_version}`)
  return [...groups.values()].map((answers) => {
    const first = answers[0]!
    const labeler = labelers[first.question_id]
    const metricRows: TypedQuestionMetricRow[] = answers.map((answer) => ({
      probability: probability(answer.answer_json),
      label: labeler ? labeler(database, answer.subject_ref) : null,
      error: answer.error,
      latencyMs: answer.latency_ms,
      inputTokens: answer.input_tokens,
    }))
    const threshold = declaredThreshold(first.question_id, first.question_version)
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
