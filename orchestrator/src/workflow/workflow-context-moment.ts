// concern: workflows
/** Gathers the plain post-advance cursor values consumed by context moment policy. */
import { type ContextMomentEffect, contextMomentEffect } from '../../../shared/context-moment.ts'
import type { AnswerRunReport } from '../run/run-answer.ts'

export type WorkflowContextMoment = { taskKey: string | null; effect: ContextMomentEffect }

export function workflowQuestionContextMoment(input: {
  moment: 'workflow-await' | 'workflow-rule'
  taskKey: string | null | undefined
  questionId: number
  text: string
  operatorRuled?: boolean
}): WorkflowContextMoment {
  return { taskKey: input.taskKey ?? null, effect: contextMomentEffect(input) }
}

export function workflowNextContextMoment(
  input: {
    cursorRecordId: string
    workflowKey: string | null
    workflow: string
    cursor: number
    finished: boolean
    stepSlug?: string
    stepTitle?: string
  },
  selfRulingQuestionNumber?: number,
  selfRuling?: string,
): WorkflowContextMoment {
  if (selfRuling !== undefined && selfRulingQuestionNumber === undefined)
    throw new Error('the recorded self-ruling has no question id')
  const taskKey = input.workflowKey
  return {
    taskKey,
    effect: contextMomentEffect({
      moment: 'workflow-next',
      taskKey,
      questionId: selfRulingQuestionNumber,
      text: selfRuling,
      cursor: {
        workflow: input.workflow,
        number: input.cursor,
        stepSlug: input.stepSlug,
        stepTitle: input.stepTitle,
        finished: input.finished,
      },
    }),
  }
}

export function answeredQuestionContextMoments(
  answeredQuestions: AnswerRunReport['answeredQuestions'],
  textForQuestion: (recordId: string) => string | undefined,
): WorkflowContextMoment[] {
  return answeredQuestions.map((question) => ({
    taskKey: question.taskHolder,
    effect: contextMomentEffect({
      moment: 'question-answer',
      taskKey: question.taskHolder,
      questionId: question.number,
      operatorRuled: question.fromOperator,
      text: textForQuestion(question.recordId),
    }),
  }))
}
