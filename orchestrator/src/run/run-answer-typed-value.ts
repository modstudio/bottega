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
  noOptionFits?: true
  fromOperator: boolean
}

type TypedAnswerValue =
  | { value: AnswerValue; noOptionFits?: never }
  | { value?: never; noOptionFits: true }
type AnswerableKind = 'choice' | 'yesno' | 'score'

function leadingAnswerSegment(answer: string): string {
  return answer.split(/\.|:|;|[\r\n]| — | - /u, 1)[0]!.trim()
}

function inferredAnswerSegments(answer: string): string[] {
  const whole = answer.trim()
  const leading = leadingAnswerSegment(answer)
  return whole === leading ? [whole] : [whole, leading]
}

function allowedValues(typed: ReturnType<typeof decodeWorkerQuestion>): string[] {
  if (typed.kind === 'choice') return typed.options.map(({ name }) => name)
  if (typed.kind === 'yesno') return ['yes', 'no']
  if (typed.kind === 'score') return typed.levels.map((_, index) => String(index))
  return []
}

function missingTypedValueRefusal(
  question: TypedAnswerQuestion,
  kind: AnswerableKind,
  values: string[],
): Error {
  const noneRemedy = kind === 'choice' || kind === 'score' ? ' (or --value none)' : ''
  const leading =
    kind === 'choice' ? 'the option name' : kind === 'yesno' ? 'yes or no' : 'the level number'
  return new Error(
    `question ${question.number} requires a typed value; allowed values: ${values.join(', ')}; ` +
      `pass --value <name>${noneRemedy}, or start the ruling with ${leading}`,
  )
}

function storedAllowedValues(question: TypedAnswerQuestion, kind: AnswerableKind): string[] {
  if (kind === 'yesno') return ['yes', 'no']
  try {
    const values = JSON.parse(
      kind === 'choice'
        ? (question.typed_options ?? question.options ?? '[]')
        : (question.levels ?? '[]'),
    ) as unknown
    if (!Array.isArray(values)) return []
    if (kind === 'score') return values.map((_, index) => String(index))
    return values.flatMap((option) => {
      if (typeof option === 'string') return [option]
      if (
        option &&
        typeof option === 'object' &&
        'name' in option &&
        typeof option.name === 'string'
      )
        return [option.name]
      return []
    })
  } catch {
    return []
  }
}

function typedAnswerValue(
  question: TypedAnswerQuestion,
  answer: string,
  explicit: unknown,
): TypedAnswerValue | undefined {
  let typed: ReturnType<typeof decodeWorkerQuestion>
  try {
    typed = decodeWorkerQuestion(question)
  } catch {
    if (question.kind === 'choice' || question.kind === 'yesno' || question.kind === 'score')
      throw missingTypedValueRefusal(
        question,
        question.kind,
        storedAllowedValues(question, question.kind),
      )
    return undefined
  }
  if (typed.kind === 'text') return undefined
  let value = explicit
  if (typed.kind === 'yesno' && typeof value === 'string') {
    if (value.toLowerCase() === 'yes') value = true
    if (value.toLowerCase() === 'no') value = false
  }
  if (value === undefined && typed.kind === 'choice') {
    for (const segment of inferredAnswerSegments(answer)) {
      const normalized = normalizeWorkerQuestionChoice(segment)
      const matches = typed.options.filter(
        ({ name }) => normalizeWorkerQuestionChoice(name) === normalized,
      )
      if (matches.length !== 1) continue
      value = matches[0]!.name
      break
    }
  }
  if (value === undefined && typed.kind === 'yesno') {
    for (const segment of inferredAnswerSegments(answer)) {
      const normalized = segment.toLowerCase()
      if (normalized === 'yes' || normalized === 'true') value = true
      if (normalized === 'no' || normalized === 'false') value = false
      if (value !== undefined) break
    }
  }
  if (value === undefined && typed.kind === 'score')
    value = inferredAnswerSegments(answer).find((segment) => /^\d+$/.test(segment))
  if (value === undefined)
    throw missingTypedValueRefusal(question, typed.kind, allowedValues(typed))
  try {
    return { value: decodeAnswerValue(typed, value) }
  } catch (error) {
    if (
      typeof value === 'string' &&
      normalizeWorkerQuestionChoice(value) === 'none' &&
      (typed.kind === 'choice' || typed.kind === 'score')
    ) {
      return { noOptionFits: true }
    }
    const detail = typed.kind === 'yesno' ? 'allowed values: yes, no' : (error as Error).message
    throw new Error(`question ${question.number} refuses that typed value; ${detail}`)
  }
}

export function answeredQuestion(
  question: TypedAnswerQuestion,
  answer: string,
  fromOperator: boolean,
  explicitValue?: unknown,
): AnsweredQuestion {
  const typed = typedAnswerValue(question, answer, explicitValue)
  return {
    number: question.number,
    record_id: question.record_id,
    question: question.question,
    answer,
    ...(typed?.value !== undefined ? { typedValue: typed.value } : {}),
    ...(typed?.noOptionFits ? { noOptionFits: true as const } : {}),
    fromOperator,
  }
}
