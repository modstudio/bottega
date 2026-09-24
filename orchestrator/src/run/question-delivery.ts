// concern: question-delivery
/** Owns durable ruling-delivery writes. */

import { db } from '../database/db.ts'
import type { QuestionDeliveryMode, QuestionDeliveryOutcome } from './question-vocabulary.ts'

export function appendQuestionDeliveries(
  questionIds: number[],
  delivery: {
    runId: number | null
    mode: QuestionDeliveryMode
    outcome: QuestionDeliveryOutcome
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
