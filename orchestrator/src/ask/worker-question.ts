// concern: worker-question
/** Typed worker-question vocabulary, storage codec, and answer validation. */

import { z } from 'zod'
import type { WORKER_QUESTION_KINDS } from '../../../shared/orch-contract.ts'

const nullableAbsent = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === null ? undefined : value), schema.optional())
const requiredQuestion = z.preprocess((value) => String(value ?? ''), z.string())
const choiceOption = z
  .object({
    name: z.string().trim().min(1),
    criteria: nullableAbsent(z.string()),
  })
  .transform(({ name, criteria }) => ({ name, ...(criteria === undefined ? {} : { criteria }) }))
const choice = z
  .object({
    kind: z.literal('choice'),
    question: requiredQuestion,
    why: nullableAbsent(z.string().trim()).default(''),
    options: z
      .array(z.union([z.string().transform((name) => ({ name })), choiceOption]))
      .min(2, 'choice needs at least two options')
      .superRefine((options, context) => {
        const names = new Set<string>()
        options.forEach((option, index) => {
          if (names.has(option.name))
            context.addIssue({
              code: 'custom',
              path: [index, 'name'],
              message: `duplicate option name ${option.name}`,
            })
          names.add(option.name)
        })
      }),
    recommendation: nullableAbsent(z.string()),
  })
  .superRefine((question, context) => {
    if (
      question.recommendation &&
      !question.options.some(({ name }) => name === question.recommendation)
    )
      context.addIssue({
        code: 'custom',
        path: ['recommendation'],
        message: `recommendation must name one of: ${question.options.map(({ name }) => name).join(', ')}`,
      })
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
  levels: z.array(z.string().trim().min(1)).min(2).max(10),
})
const text = z.object({
  kind: z.literal('text'),
  question: requiredQuestion,
  why: nullableAbsent(z.string().trim()).default(''),
})

export const WorkerQuestionInputSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
    const value = raw as Record<string, unknown>
    const kind = value.kind ?? undefined
    if (kind === undefined)
      return {
        ...value,
        kind: Array.isArray(value.options) && value.options.length ? 'choice' : 'text',
      }
    return value
  },
  z.discriminatedUnion('kind', [choice, yesno, score, text]),
)

export const WorkerQuestionSchema = WorkerQuestionInputSchema
export type WorkerQuestion = z.infer<typeof WorkerQuestionInputSchema>
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
  return WorkerQuestionInputSchema.parse({
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

function choiceAnswer(question: Extract<WorkerQuestion, { kind: 'choice' }>, raw: unknown): string {
  if (typeof raw === 'string') {
    const option = question.options.find(({ name }) => name === raw)
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
