// concern: workflows
/** Gathers the plain post-advance cursor values consumed by context moment policy. */
import {
  type ContextMomentEffect,
  type ContextMomentHolder,
  contextMomentEffect,
} from '../doc/context-moment.ts'

export type WorkflowContextMoment = {
  taskKey: string | null
  cursorRecordId: string | null
  effect: ContextMomentEffect
}
export type WorkflowNextMomentInput = {
  workflowKey: string | null
  cursorRecordId: string
}
export type WorkflowNextCommandMoment = {
  cursorRecordId: string
  taskKey: string | null
  selfRulingQuestionNumber?: number
  selfRuling?: string
}

const contextHolder = (
  taskKey: string | null | undefined,
  cursorRecordId: string | null | undefined,
): ContextMomentHolder | null => {
  const task = taskKey?.trim()
  if (task) return { kind: 'task', value: task }
  const cursor = cursorRecordId?.trim()
  return cursor ? { kind: 'cursor', value: cursor } : null
}

export function workflowQuestionContextMoment(input: {
  taskKey: string | null | undefined
  cursorRecordId: string
  questionId: number
  text: string
  operatorRuled?: boolean
}): WorkflowContextMoment {
  return {
    taskKey: input.taskKey ?? null,
    cursorRecordId: input.cursorRecordId,
    effect: contextMomentEffect({
      holder: contextHolder(input.taskKey, input.cursorRecordId),
      questionId: input.questionId,
      operatorRuled: input.operatorRuled,
      text: input.text,
    }),
  }
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
    cursorRecordId: input.cursorRecordId,
    effect: contextMomentEffect({
      holder: contextHolder(taskKey, input.cursorRecordId),
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
    cursorRecordId: null,
    effect: contextMomentEffect({
      holder: contextHolder(question.taskHolder, null),
      questionId: question.number,
      operatorRuled: question.fromOperator,
      text: textForQuestion(question.recordId),
    }),
  }))
}
