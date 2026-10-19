// concern: question-delivery
/** Owns durable ruling-delivery writes. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import type { QuestionDeliveryMode, QuestionDeliveryOutcome } from './question-vocabulary.ts'

export function appendQuestionDeliveries(
  questionIds: number[],
  delivery: {
    runId: string | null
    mode: QuestionDeliveryMode
    outcome: QuestionDeliveryOutcome
    at: string
    error?: string | null
  },
  database: Database = db(),
): void {
  const insert = database.query(
    `INSERT INTO question_delivery (record_id, question_id, run_record_id, mode, outcome, at, error)
     VALUES (?,?,?,?,?,?,?)`,
  )
  for (const questionId of questionIds) {
    insert.run(
      newRecordId(),
      questionId,
      delivery.runId,
      delivery.mode,
      delivery.outcome,
      delivery.at,
      delivery.error ?? null,
    )
  }
}
