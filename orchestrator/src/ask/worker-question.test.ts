import { expect, test } from 'bun:test'
import { answerValueRefusal, WorkerQuestionSchema } from './worker-question.ts'

test('legacy string options decode as a choice', () => {
  expect(
    WorkerQuestionSchema.parse({
      question: 'Which?',
      why: 'Changes it.',
      options: ['a', 'b'],
      recommendation: 'a',
    }),
  ).toEqual({
    kind: 'choice',
    question: 'Which?',
    why: 'Changes it.',
    options: [{ name: 'a' }, { name: 'b' }],
    recommendation: 'a',
  })
})

test('invalid typed questions name the defect', () => {
  const result = WorkerQuestionSchema.safeParse({
    kind: 'choice',
    question: 'Which?',
    why: 'Changes it.',
    options: [{ name: 'a' }, { name: 'a' }],
  })
  expect(result.success).toBe(false)
  if (!result.success) expect(result.error.message).toContain('duplicate option name a')
})

test('an answer outside the choices is refused with allowed values', () => {
  const question = WorkerQuestionSchema.parse({
    kind: 'choice',
    question: 'Which?',
    why: 'Changes it.',
    options: [{ name: 'a' }, { name: 'b' }],
  })
  expect(answerValueRefusal(question, 'c')).toBe('allowed values: a, b')
})
