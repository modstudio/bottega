// concern: run-answer-typed-value
/** Decodes stored worker questions and validates answer values for the answer service. */

import {
  answerValueRefusal,
  type WorkerQuestion,
  WorkerQuestionSchema,
} from '../../../shared/worker-question.ts'

export type TypedAnswerQuestion = {
  record_id: string
  number: number
  question: string
  why: string | null
  kind: string
  typed_options: string | null
  criteria: string | null
  levels: string | null
}

export type AnsweredQuestion = {
  number: number
  record_id: string
  question: string
  answer: string
  typedValue?: string | boolean | number
  fromOperator: boolean
}

function storedWorkerQuestion(question: TypedAnswerQuestion): WorkerQuestion {
  return WorkerQuestionSchema.parse({
    question: question.question,
    why: question.why ?? '',
    kind: question.kind,
    ...(question.kind === 'choice' ? { options: JSON.parse(question.typed_options ?? '[]') } : {}),
    ...(question.kind === 'yesno' && question.criteria
      ? { criteria: JSON.parse(question.criteria) }
      : {}),
    ...(question.kind === 'score' ? { levels: JSON.parse(question.levels ?? '[]') } : {}),
  })
}

function typedAnswerValue(
  question: TypedAnswerQuestion,
  answer: string,
  explicit: string | boolean | number | undefined,
): string | boolean | number | undefined {
  const typed = storedWorkerQuestion(question)
  let value = explicit
  if (value === undefined && typed.kind === 'choice') {
    const normalized = answer.trim().toLowerCase()
    value = typed.options.find(({ name }) => name.trim().toLowerCase() === normalized)?.name
  }
  if (value === undefined) return undefined
  const refusal = answerValueRefusal(typed, value)
  if (refusal) throw new Error(`question ${question.number} refuses that typed value; ${refusal}`)
  return value
}

export function answeredQuestion(
  question: TypedAnswerQuestion,
  answer: string,
  fromOperator: boolean,
  explicitValue?: string | boolean | number,
): AnsweredQuestion {
  const typedValue = typedAnswerValue(question, answer, explicitValue)
  return {
    number: question.number,
    record_id: question.record_id,
    question: question.question,
    answer,
    ...(typedValue !== undefined ? { typedValue } : {}),
    fromOperator,
  }
}
