// concern: question-answer-resume-failure
/** Restores answered questions when their continuation cannot be launched. */

import { db, writeTransaction } from '../database/db.ts'
import { mutateQuestion } from '../question-store/question-store-mutation.ts'
import { appendQuestionDeliveries } from './question-delivery.ts'
import { clearQuestionDeliveryPending } from './question-delivery-pending.ts'
import {
  QUESTION_DELIVERY_MODE_RESUME,
  QUESTION_DELIVERY_OUTCOME_FAILED,
} from './question-vocabulary.ts'

export type ResumeFailureQuestion = { record_id: string; awaiting_operator_at: string | null }

export async function restoreOpenQuestionsAfterResumeFailure(
  open: ResumeFailureQuestion[],
  actorSession: string | null,
  error: string,
): Promise<void> {
  writeTransaction(() => {
    appendQuestionDeliveries(
      open.map((question) => question.record_id),
      {
        runId: null,
        mode: QUESTION_DELIVERY_MODE_RESUME,
        outcome: QUESTION_DELIVERY_OUTCOME_FAILED,
        at: new Date(Date.now()).toISOString(),
        error,
      },
    )
  })
  clearQuestionDeliveryPending(
    db(),
    open.map(({ record_id }) => record_id),
  )
  for (const q of open)
    await mutateQuestion(db(), {
      id: q.record_id,
      intent: 'answer',
      at: new Date(Date.now()).toISOString(),
      actorSession,
      reason: 'resume failed',
      changes: {
        answer: null,
        answerValue: null,
        answeredByKind: null,
        jevAgreed: null,
        answeredAt: null,
        answeredBy: null,
        answeredByName: null,
        answererKind: null,
        answerChannel: null,
        awaitingOperatorAt: q.awaiting_operator_at,
      },
    })
}
