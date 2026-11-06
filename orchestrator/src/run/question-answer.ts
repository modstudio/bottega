// concern: question-answer
/** The single stored-question answer transition used by every answer channel. */

import type { Database } from 'bun:sqlite'
import { appendQuestionDeliveries } from './question-delivery.ts'
import { questionOpenSql } from './question-open.ts'
import { enqueueQuestionRecord } from './question-outbox.ts'
import type {
  AnswerChannel,
  QuestionDeliveryMode,
  QuestionDeliveryOutcome,
} from './question-vocabulary.ts'
import {
  QUESTION_DELIVERY_MODE_LIVE,
  QUESTION_DELIVERY_MODE_RECORD_ONLY,
  QUESTION_DELIVERY_OUTCOME_DELIVERED,
} from './question-vocabulary.ts'
import type { answerAttributions } from './ruling-attribution.ts'
import type { AnsweredQuestion } from './run-answer-typed-value.ts'

export function applyQuestionAnswer(input: {
  database: Database
  questionId: string
  answer: string
  value?: string | boolean | number
  answeredAt: string
  answeredBy: string | null
  answeredByName: string | null
  answeredByKind: 'architect' | 'jev'
  answererKind: 'agent' | 'operator' | 'eval' | null
  channel: AnswerChannel
  deliveryPendingAt: string | null
  delivery?: {
    runId: string | null
    mode: QuestionDeliveryMode
    outcome: QuestionDeliveryOutcome
  }
}): boolean {
  const encodedValue = input.value === undefined ? null : JSON.stringify(input.value)
  const changed = input.database
    .query(
      `UPDATE question
       SET answer=?,answer_value=?,answered_by_kind=?,
           jev_agreed=CASE WHEN ?='jev' OR jev_pick IS NULL OR ? IS NULL THEN NULL WHEN jev_pick=? THEN 1 ELSE 0 END,
           answered_at=?,answered_by=?,answered_by_name=?,answerer_kind=?,answer_channel=?,revision=revision+1,
           delivery_pending_at=?,awaiting_operator_at=NULL
       WHERE record_id=? AND ${questionOpenSql('question')}`,
    )
    .run(
      input.answer,
      encodedValue,
      input.answeredByKind,
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
  if (changed.changes !== 1) return false
  if (input.delivery)
    appendQuestionDeliveries(
      [input.questionId],
      { ...input.delivery, at: input.answeredAt },
      input.database,
    )
  enqueueQuestionRecord(input.database, input.questionId)
  return true
}

export function applyArchitectQuestionAnswers(input: {
  database: Database
  answers: AnsweredQuestion[]
  attributions: ReturnType<typeof answerAttributions>
  answeredAt: string
  channel: AnswerChannel
  ownersLive: boolean
  skipResume: boolean
  open: Array<{ record_id: string; owner_id: string }>
  refusal: (questionId: string) => string
}): void {
  input.answers.forEach((answer, index) => {
    const [answeredBy, answeredByName, answererKind] = input.attributions[index]!
    const delivery: Parameters<typeof applyQuestionAnswer>[0]['delivery'] =
      input.skipResume || input.ownersLive
        ? {
            runId: input.skipResume
              ? null
              : input.open.find((question) => question.record_id === answer.record_id)!.owner_id,
            mode: input.skipResume
              ? QUESTION_DELIVERY_MODE_RECORD_ONLY
              : QUESTION_DELIVERY_MODE_LIVE,
            outcome: QUESTION_DELIVERY_OUTCOME_DELIVERED,
          }
        : undefined
    const changed = applyQuestionAnswer({
      database: input.database,
      questionId: answer.record_id,
      answer: answer.answer,
      value: answer.typedValue,
      answeredAt: input.answeredAt,
      answeredBy,
      answeredByName,
      answeredByKind: 'architect',
      answererKind,
      channel: input.channel,
      deliveryPendingAt: input.ownersLive ? null : input.answeredAt,
      ...(delivery ? { delivery } : {}),
    })
    if (!changed) throw new Error(input.refusal(answer.record_id))
  })
}
