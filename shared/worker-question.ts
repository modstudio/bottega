// concern: worker-question
/** Typed worker-question vocabulary and edge validation. */

import { z } from 'zod'

const choiceOption = z.object({ name: z.string().trim().min(1), criteria: z.string().optional() })
const requiredQuestion = z.preprocess((value) => String(value ?? ''), z.string())
const choice = z
  .object({
    kind: z.literal('choice'),
    question: requiredQuestion,
    why: z.string().trim().default(''),
    options: z
      .array(choiceOption)
      .min(2)
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
    recommendation: z.string().optional(),
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
  why: z.string().trim().default(''),
  criteria: z.object({ yes: z.string().optional(), no: z.string().optional() }).optional(),
})
const score = z.object({
  kind: z.literal('score'),
  question: requiredQuestion,
  why: z.string().trim().default(''),
  levels: z.array(z.string().trim().min(1)).min(2).max(10),
})
const text = z.object({
  kind: z.literal('text'),
  question: requiredQuestion,
  why: z.string().trim().default(''),
})

export const WorkerQuestionSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
    const value = raw as Record<string, unknown>
    if (value.kind === undefined) {
      if (Array.isArray(value.options) && value.options.length)
        return {
          ...value,
          kind: 'choice',
          options: value.options.map((option) =>
            typeof option === 'string' ? { name: option } : option,
          ),
        }
      return { ...value, kind: 'text' }
    }
    return value
  },
  z.discriminatedUnion('kind', [choice, yesno, score, text]),
)

export type WorkerQuestion = z.infer<typeof WorkerQuestionSchema>
export type WorkerQuestionInput = {
  kind?: 'choice' | 'yesno' | 'score' | 'text' | null
  question: string
  why?: string | null
  options?: (string | { name: string; criteria?: string | null })[] | null
  recommendation?: string | null
  criteria?: { yes?: string | null; no?: string | null } | null
  levels?: string[] | null
}
export function answerValueRefusal(question: WorkerQuestion, value: unknown): string | null {
  if (question.kind === 'choice')
    return typeof value === 'string' && question.options.some(({ name }) => name === value)
      ? null
      : `allowed values: ${question.options.map(({ name }) => name).join(', ')}`
  if (question.kind === 'yesno')
    return typeof value === 'boolean' ? null : 'allowed values: true, false'
  if (question.kind === 'score')
    return Number.isInteger(value) &&
      (value as number) >= 0 &&
      (value as number) < question.levels.length
      ? null
      : `allowed values: ${question.levels.map((_, index) => index).join(', ')}`
  return typeof value === 'string' ? null : 'allowed value: text'
}
