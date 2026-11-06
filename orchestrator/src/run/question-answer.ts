// concern: question-answer
/** The single stored-question answer transition used by every answer channel. */

import type { Database } from 'bun:sqlite'
import { appendQuestionDeliveries } from './question-delivery.ts'
import { enqueueQuestionRecord } from './question-outbox.ts'
import type {
  AnswerChannel,
  QuestionDeliveryMode,
  QuestionDeliveryOutcome,
} from './question-vocabulary.ts'

export function applyQuestionAnswer(input: {
  database: Database
  questionId: string
  answer: string
  value?: string | boolean | number
  answeredAt: string
  answeredBy: string | null
  answeredByName: string | null
  answeredByKind: 'architect' | 'jev'
  answererKind: 'agent' | 'operator'
  channel: AnswerChannel
  deliveryPendingAt: string | null
  delivery?: {
    runId: string | null
    mode: QuestionDeliveryMode
    outcome: QuestionDeliveryOutcome
  }
}): void {
  const encodedValue = input.value === undefined ? null : JSON.stringify(input.value)
  const changed = input.database
    .query(
      `UPDATE question
       SET answer=?,answer_value=?,answered_by_kind=?,
           jev_agreed=CASE WHEN jev_pick IS NULL OR ? IS NULL THEN NULL WHEN jev_pick=? THEN 1 ELSE 0 END,
           answered_at=?,answered_by=?,answered_by_name=?,answerer_kind=?,answer_channel=?,revision=revision+1,
           delivery_pending_at=?,awaiting_operator_at=NULL
       WHERE record_id=?`,
    )
    .run(
      input.answer,
      encodedValue,
      input.answeredByKind,
      encodedValue,
      encodedValue,
      input.answeredAt,
      input.answeredBy,
      input.answeredByName,
      input.answererKind,
      input.channel,
      input.deliveryPendingAt,
      input.questionId,
    )
  if (changed.changes !== 1) throw new Error(`question ${input.questionId} does not exist`)
  if (input.delivery)
    appendQuestionDeliveries(
      [input.questionId],
      { ...input.delivery, at: input.answeredAt },
      input.database,
    )
  enqueueQuestionRecord(input.database, input.questionId)
}
