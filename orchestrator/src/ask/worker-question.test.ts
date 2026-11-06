import { describe, expect, test } from 'bun:test'
import { decodeAnswerValue, WorkerQuestionSchema } from './worker-question.ts'

describe('worker question vocabulary', () => {
  test('decodes legacy options as a choice', () => {
    expect(
      WorkerQuestionSchema.parse({
        question: 'Which?',
        why: 'Changes the implementation.',
        options: ['a', 'b'],
      }),
    ).toEqual({
      kind: 'choice',
      question: 'Which?',
      why: 'Changes the implementation.',
      options: [{ name: 'a' }, { name: 'b' }],
    })
  })

  test('names an invalid typed question defect', () => {
    const result = WorkerQuestionSchema.safeParse({
      kind: 'choice',
      question: 'Which?',
      why: 'Changes it.',
      options: [{ name: 'only' }],
    })
    expect(result.success).toBeFalse()
    if (!result.success) expect(result.error.issues[0]?.message).toContain('at least two')
  })

  test('refuses an answer outside the allowed values', () => {
    const question = WorkerQuestionSchema.parse({
      kind: 'score',
      question: 'How much?',
      why: 'Changes it.',
      levels: ['low', 'high'],
    })
    expect(() => decodeAnswerValue(question, 2)).toThrow('allowed values: 0, 1')
  })
})
