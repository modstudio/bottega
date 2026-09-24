// concern: run-answer
/** Owns durable question provenance and ruling-delivery facts. */

import { db } from '../database/db.ts'

export const ANSWER_CHANNELS = ['cli', 'mcp', 'ui'] as const
export type AnswererKind = 'agent' | 'operator' | 'eval'
export type QuestionDeliveryMode = 'live' | 'resume' | 'retry' | 'record-only'

export function answererKindFromAnsweredBy(answeredBy: string | null): AnswererKind | null {
  if (answeredBy === null) return null
  if (answeredBy.startsWith('operator via ')) return 'operator'
  if (answeredBy === 'canon-eval') return 'eval'
  return 'agent'
}

export function appendQuestionDeliveries(
  questionIds: number[],
  delivery: {
    runId: number | null
    mode: QuestionDeliveryMode
    outcome: 'delivered' | 'failed'
    at: string
    error?: string | null
  },
): void {
  const insert = db().query(
    `INSERT INTO question_delivery (question_id, run_id, mode, outcome, at, error)
     VALUES (?,?,?,?,?,?)`,
  )
  for (const questionId of questionIds) {
    insert.run(
      questionId,
      delivery.runId,
      delivery.mode,
      delivery.outcome,
      delivery.at,
      delivery.error ?? null,
    )
  }
}

export function appendLiveQuestionDeliveries(
  questions: { id: number; owner_id: number }[],
  at: string,
): void {
  for (const question of questions) {
    appendQuestionDeliveries([question.id], {
      runId: question.owner_id,
      mode: 'live',
      outcome: 'delivered',
      at,
    })
  }
}
