// concern: run-answer-typed-value
/** Decodes stored worker questions and validates answer values for the answer service. */

import {
  type AnswerValue,
  decodeAnswerValue,
  decodeWorkerQuestion,
  normalizeWorkerQuestionChoice,
  type WorkerQuestion,
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
  return answer.split(/\.|:|;|,|[\r\n]| — | - /u, 1)[0]!.trim()
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
  const noOptionFits = kind === 'choice' || kind === 'score'
  const noneRemedy = noOptionFits ? ' (or --value none)' : ''
  const leading =
    kind === 'choice' ? 'the option name' : kind === 'yesno' ? 'yes or no' : 'the level number'
  return new Error(
    `question ${question.number} requires a typed value; allowed values: ${values.join(', ')}; ` +
      `pass --value <name>${noneRemedy}, or start the ruling with ${leading}` +
      (noOptionFits ? ' or None:' : ''),
  )
}

function inferredAnswerValue(typed: WorkerQuestion, answer: string): unknown {
  for (const segment of inferredAnswerSegments(answer)) {
    try {
      decodeAnswerValue(typed, segment)
      return segment
    } catch {
      // Try the leading segment after the whole ruling.
    }
  }
  if (
    (typed.kind === 'choice' || typed.kind === 'score') &&
    normalizeWorkerQuestionChoice(leadingAnswerSegment(answer)) === 'none'
  )
    return leadingAnswerSegment(answer)
  return undefined
}

function isNoOptionFits(typed: WorkerQuestion, value: unknown): boolean {
  return (
    typeof value === 'string' &&
    normalizeWorkerQuestionChoice(value) === 'none' &&
    (typed.kind === 'choice' || typed.kind === 'score')
  )
}

function decodeTypedAnswer(
  question: TypedAnswerQuestion,
  typed: WorkerQuestion,
  value: unknown,
): TypedAnswerValue {
  try {
    return { value: decodeAnswerValue(typed, value) }
  } catch (error) {
    if (isNoOptionFits(typed, value)) return { noOptionFits: true }
    throw new Error(
      `question ${question.number} refuses that typed value; ${(error as Error).message}`,
    )
  }
}

function bareNoOptionFitsRefusal(question: TypedAnswerQuestion): Error {
  return new Error(
    `question ${question.number} refuses a bare none ruling; the ruling needs a sentence saying what to do instead; ` +
      'use --value none "<what to do>" or None: <what to do>',
  )
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
    return undefined
  }
  if (typed.kind === 'text')
    return explicit === undefined ? undefined : decodeTypedAnswer(question, typed, explicit)
  const value = explicit === undefined ? inferredAnswerValue(typed, answer) : explicit
  if (value === undefined)
    throw missingTypedValueRefusal(question, typed.kind, allowedValues(typed))
  const decoded = decodeTypedAnswer(question, typed, value)
  if (decoded.noOptionFits && normalizeWorkerQuestionChoice(answer) === 'none')
    throw bareNoOptionFitsRefusal(question)
  return decoded
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
