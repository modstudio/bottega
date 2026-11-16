// concern: question-answer
/** The single stored-question answer transition used by every answer channel. */

import type { Database } from 'bun:sqlite'
import { mutateQuestion, questionById } from '../question-store/question-store-mutation.ts'
import { appendQuestionDeliveries } from './question-delivery.ts'
import {
  clearQuestionDeliveryPending,
  markQuestionDeliveryPending,
} from './question-delivery-pending.ts'
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

export async function applyQuestionAnswer(input: {
  database: Database
  questionId: string
  answer: string
  value?: string | boolean | number
  noOptionFits?: boolean
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
}): Promise<boolean> {
  const encodedValue = input.value === undefined ? null : JSON.stringify(input.value)
  const row = await questionById(input.database, input.questionId)
  if (!row || row.answered_at !== null || row.closed_at !== null) return false
  const jevPick = typeof row.jev_pick === 'string' ? row.jev_pick : null
  const jevAgreed =
    input.answeredByKind === 'jev' || jevPick === null
      ? null
      : input.noOptionFits
        ? 0
        : encodedValue === null
          ? null
          : Number(jevPick === encodedValue)
  const mutation = await mutateQuestion(input.database, {
    id: input.questionId,
    intent: 'answer',
    at: input.answeredAt,
    actorSession: input.answeredBy,
    reason: input.answer,
    requireOpen: true,
    changes: {
      answer: input.answer,
      answerValue: encodedValue,
      answeredByKind: input.answeredByKind,
      jevAgreed,
      answeredAt: input.answeredAt,
      answeredBy: input.answeredBy,
      answeredByName: input.answeredByName,
      answererKind: input.answererKind,
      answerChannel: input.channel,
      awaitingOperatorAt: null,
    },
  })
  if (!mutation.applied) return false
  if (input.deliveryPendingAt)
    markQuestionDeliveryPending(input.database, input.questionId, input.deliveryPendingAt)
  else clearQuestionDeliveryPending(input.database, [input.questionId])
  if (input.delivery)
    appendQuestionDeliveries(
      [input.questionId],
      { ...input.delivery, at: input.answeredAt },
      input.database,
    )
  enqueueQuestionRecord(input.database, input.questionId)
  return true
}

export async function applyArchitectQuestionAnswers(input: {
  database: Database
  answers: AnsweredQuestion[]
  attributions: ReturnType<typeof answerAttributions>
  answeredAt: string
  channel: AnswerChannel
  ownersLive: boolean
  skipResume: boolean
  open: Array<{ record_id: string; owner_id: string }>
  refusal: (questionId: string) => string
}): Promise<void> {
  for (const [index, answer] of input.answers.entries()) {
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
    const changed = await applyQuestionAnswer({
      database: input.database,
      questionId: answer.record_id,
      answer: answer.answer,
      value: answer.typedValue,
      noOptionFits: answer.noOptionFits,
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
  }
}
