// concern: workflows
/** Gathers the plain post-advance cursor values consumed by context moment policy. */
import { type ContextMomentEffect, contextMomentEffect } from '../doc/context-moment.ts'

export type WorkflowContextMoment = { taskKey: string | null; effect: ContextMomentEffect }
export type WorkflowNextMomentInput = {
  workflowKey: string | null
}
export type WorkflowNextCommandMoment = {
  cursorRecordId: string
  taskKey: string | null
  selfRulingQuestionNumber?: number
  selfRuling?: string
}

export function workflowQuestionContextMoment(input: {
  taskKey: string | null | undefined
  questionId: number
  text: string
  operatorRuled?: boolean
}): WorkflowContextMoment {
  return { taskKey: input.taskKey ?? null, effect: contextMomentEffect(input) }
}

export function workflowNextContextMoment(
  input: WorkflowNextMomentInput,
  selfRulingQuestionNumber?: number,
  selfRuling?: string,
): WorkflowContextMoment {
  if (selfRuling !== undefined && selfRulingQuestionNumber === undefined)
    throw new Error('the recorded self-ruling has no question id')
  const taskKey = input.workflowKey
  return {
    taskKey,
    effect: contextMomentEffect({
      taskKey,
      questionId: selfRulingQuestionNumber,
      text: selfRuling,
    }),
  }
}

export function answeredQuestionContextMoments(
  answeredQuestions: readonly {
    recordId: string
    number: number
    fromOperator: boolean
    taskHolder: string | null
  }[],
  textForQuestion: (recordId: string) => string | undefined,
): WorkflowContextMoment[] {
  return answeredQuestions.map((question) => ({
    taskKey: question.taskHolder,
    effect: contextMomentEffect({
      taskKey: question.taskHolder,
      questionId: question.number,
      operatorRuled: question.fromOperator,
      text: textForQuestion(question.recordId),
    }),
  }))
}
