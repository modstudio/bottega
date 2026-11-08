// concern: worker-question
/** Typed worker-question vocabulary, storage codec, and answer validation. */

import { z } from 'zod'
import { WORKER_QUESTION_KINDS } from '../../../shared/orch-contract.ts'

const nullableAbsent = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === null ? undefined : value), schema.optional())
const requiredQuestion = z.preprocess((value) => String(value ?? ''), z.string())

export function normalizeWorkerQuestionChoice(value: string): string {
  return value
    .replace(/\p{Cf}/gu, '')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('und')
}

const choiceOption = z
  .object({
    name: z.string().trim(),
    criteria: nullableAbsent(z.string()),
  })
  .transform(({ name, criteria }) => ({ name, ...(criteria === undefined ? {} : { criteria }) }))
const choice = z
  .object({
    kind: z.literal('choice'),
    question: requiredQuestion,
    why: nullableAbsent(z.string().trim()).default(''),
    options: z
      .array(
        z.union([
          z
            .string()
            .trim()
            .transform((name) => ({ name })),
          choiceOption,
        ]),
      )
      .min(2, 'choice needs at least two options')
      .superRefine((options, context) => {
        const names = new Set<string>()
        options.forEach((option, index) => {
          const normalizedName = normalizeWorkerQuestionChoice(option.name)
          if (!normalizedName)
            context.addIssue({
              code: 'custom',
              path: [index, 'name'],
              message: `option ${index + 1} name is empty`,
            })
          if (names.has(normalizedName))
            context.addIssue({
              code: 'custom',
              path: [index, 'name'],
              message: `duplicate option name ${option.name}`,
            })
          names.add(normalizedName)
        })
      }),
    recommendation: nullableAbsent(z.string()),
  })
  .transform((question) => {
    if (question.recommendation === undefined) return question
    const recommendation = normalizeWorkerQuestionChoice(question.recommendation)
    const option = question.options.find(
      ({ name }) => normalizeWorkerQuestionChoice(name) === recommendation,
    )
    const { recommendation: _recommendation, ...withoutRecommendation } = question
    return option
      ? { ...withoutRecommendation, recommendation: option.name }
      : withoutRecommendation
  })
const yesno = z.object({
  kind: z.literal('yesno'),
  question: requiredQuestion,
  why: nullableAbsent(z.string().trim()).default(''),
  criteria: nullableAbsent(
    z.object({ yes: nullableAbsent(z.string()), no: nullableAbsent(z.string()) }),
  ),
})
const score = z.object({
  kind: z.literal('score'),
  question: requiredQuestion,
  why: nullableAbsent(z.string().trim()).default(''),
  levels: z
    .array(z.string().trim())
    .min(2)
    .max(10)
    .superRefine((levels, context) => {
      levels.forEach((level, index) => {
        if (!normalizeWorkerQuestionChoice(level))
          context.addIssue({
            code: 'custom',
            path: [index],
            message: `level ${index + 1} name is empty`,
          })
      })
    }),
})
const text = z.object({
  kind: z.literal('text'),
  question: requiredQuestion,
  why: nullableAbsent(z.string().trim()).default(''),
})

export const WorkerQuestionInputSchema = z.object({
  kind: z
    .enum(WORKER_QUESTION_KINDS)
    .nullable()
    .optional()
    .describe(
      'choice when there are named options, yesno for a yes/no ruling, score for an ordered scale, text otherwise',
    ),
  question: requiredQuestion,
  why: z.string().nullable().optional(),
  options: z
    .array(
      z.union([
        z.string(),
        z.object({ name: z.string(), criteria: z.string().nullable().optional() }),
      ]),
    )
    .nullable()
    .optional()
    .describe('An option may be a string or an object with name and criteria.'),
  recommendation: z.string().nullable().optional(),
  criteria: z
    .object({ yes: z.string().nullable().optional(), no: z.string().nullable().optional() })
    .nullable()
    .optional()
    .describe('Yesno only; what yes means and what no means.'),
  levels: z
    .array(z.string())
    .nullable()
    .optional()
    .describe('Score only; the ordered level labels, lowest first, answered by index.'),
})

const normalizedQuestion = z.discriminatedUnion('kind', [choice, yesno, score, text])

export type WorkerQuestion =
  | {
      kind: 'choice'
      question: string
      why: string
      options: { name: string; criteria?: string }[]
      recommendation?: string
    }
  | {
      kind: 'yesno'
      question: string
      why: string
      criteria?: { yes?: string; no?: string }
    }
  | { kind: 'score'; question: string; why: string; levels: string[] }
  | { kind: 'text'; question: string; why: string }

export const WorkerQuestionSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const value = raw as Record<string, unknown>
  return {
    ...value,
    kind: value.kind ?? (Array.isArray(value.options) && value.options.length ? 'choice' : 'text'),
  }
}, normalizedQuestion) as z.ZodType<WorkerQuestion>
export type WorkerQuestionInput = {
  kind?: (typeof WORKER_QUESTION_KINDS)[number] | null
  question: string
  why?: string | null
  options?: (string | { name: string; criteria?: string | null })[] | null
  recommendation?: string | null
  criteria?: { yes?: string | null; no?: string | null } | null
  levels?: string[] | null
}
export type AnswerValue = string | boolean | number

export type StoredWorkerQuestion = {
  question: string
  why: string | null
  kind: string
  options?: string | null
  typed_options: string | null
  criteria: string | null
  levels: string | null
}

export function encodeWorkerQuestion(question: WorkerQuestion): {
  kind: WorkerQuestion['kind']
  typedOptions: string | null
  criteria: string | null
  levels: string | null
} {
  return {
    kind: question.kind,
    typedOptions: question.kind === 'choice' ? JSON.stringify(question.options) : null,
    criteria:
      question.kind === 'yesno' && question.criteria ? JSON.stringify(question.criteria) : null,
    levels: question.kind === 'score' ? JSON.stringify(question.levels) : null,
  }
}

export function decodeWorkerQuestion(question: StoredWorkerQuestion): WorkerQuestion {
  const storedOptions = question.typed_options ?? question.options ?? '[]'
  return WorkerQuestionSchema.parse({
    question: question.question,
    why: question.why ?? '',
    kind: question.kind,
    ...(question.kind === 'choice' ? { options: JSON.parse(storedOptions) } : {}),
    ...(question.kind === 'yesno' && question.criteria
      ? { criteria: JSON.parse(question.criteria) }
      : {}),
    ...(question.kind === 'score' ? { levels: JSON.parse(question.levels ?? '[]') } : {}),
  })
}

function choiceAnswer(question: Extract<WorkerQuestion, { kind: 'choice' }>, raw: unknown): string {
  if (typeof raw === 'string') {
    const normalizedAnswer = normalizeWorkerQuestionChoice(raw)
    const option = question.options.find(
      ({ name }) => normalizeWorkerQuestionChoice(name) === normalizedAnswer,
    )
    if (option) return option.name
  }
  throw new Error(`allowed values: ${question.options.map(({ name }) => name).join(', ')}`)
}

function yesnoAnswer(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'string' && /^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true'
  throw new Error('allowed values: true, false')
}

function scoreAnswer(question: Extract<WorkerQuestion, { kind: 'score' }>, raw: unknown): number {
  const value = typeof raw === 'string' && /^-?\d+$/.test(raw) ? Number(raw) : raw
  if (
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) < question.levels.length
  )
    return value as number
  throw new Error(`allowed values: ${question.levels.map((_, index) => index).join(', ')}`)
}

function textAnswer(raw: unknown): string {
  if (typeof raw === 'string') return raw
  throw new Error('allowed value: text')
}

export function decodeAnswerValue(question: WorkerQuestion, raw: unknown): AnswerValue {
  if (question.kind === 'choice') return choiceAnswer(question, raw)
  if (question.kind === 'yesno') return yesnoAnswer(raw)
  if (question.kind === 'score') return scoreAnswer(question, raw)
  return textAnswer(raw)
}
