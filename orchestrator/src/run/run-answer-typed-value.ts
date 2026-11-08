// concern: run-answer-typed-value
/** Decodes stored worker questions and validates answer values for the answer service. */

import {
  type AnswerValue,
  decodeAnswerValue,
  decodeWorkerQuestion,
  normalizeWorkerQuestionChoice,
} from '../ask/worker-question.ts'

export type TypedAnswerQuestion = {
  record_id: string
  number: number
  question: string
  why: string | null
  kind: string
  options: string | null
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

function typedAnswerValue(
  question: TypedAnswerQuestion,
  answer: string,
  explicit: unknown,
): AnswerValue | undefined {
  let typed: ReturnType<typeof decodeWorkerQuestion>
  try {
    typed = decodeWorkerQuestion(question)
  } catch {
    return undefined
  }
  let value = explicit
  if (value === undefined && typed.kind === 'choice') {
    const normalized = normalizeWorkerQuestionChoice(answer)
    value = typed.options.find(
      ({ name }) => normalizeWorkerQuestionChoice(name) === normalized,
    )?.name
  }
  if (value === undefined && typed.kind === 'yesno') {
    const normalized = answer.trim().toLowerCase()
    if (normalized === 'yes' || normalized === 'true') value = true
    if (normalized === 'no' || normalized === 'false') value = false
  }
  if (value === undefined && typed.kind === 'score' && /^\d+$/.test(answer.trim()))
    value = answer.trim()
  if (value === undefined) return undefined
  try {
    return decodeAnswerValue(typed, value)
  } catch (error) {
    throw new Error(
      `question ${question.number} refuses that typed value; ${(error as Error).message}`,
    )
  }
}

export function answeredQuestion(
  question: TypedAnswerQuestion,
  answer: string,
  fromOperator: boolean,
  explicitValue?: unknown,
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
