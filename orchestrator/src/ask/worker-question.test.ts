import { describe, expect, test } from 'bun:test'
import { realQuestions } from '../outcome.ts'
import {
  decodeAnswerValue,
  normalizeWorkerQuestionChoice,
  type WorkerQuestionInput,
  WorkerQuestionSchema,
} from './worker-question.ts'

const options = ['Alpha Choice', 'Beta']
const choice = (recommendation?: string | null) => ({
  kind: 'choice' as const,
  question: 'Which option?',
  why: 'The implementation depends on the selection.',
  options,
  ...(recommendation === undefined ? {} : { recommendation }),
})

describe('worker question answerability', () => {
  test('normalizes the identity used across recommendation, duplicate, and answer matching', () => {
    expect(normalizeWorkerQuestionChoice('  AL\u200Bpha  Choice ')).toBe('alpha choice')
  })

  test.each([
    ['case', 'alpha choice', 'Alpha Choice'],
    ['leading and trailing whitespace', '  Alpha Choice  ', 'Alpha Choice'],
    ['doubled internal spaces', 'Alpha  Choice', 'Alpha Choice'],
    ['zero-width format character', 'Al\u200Bpha Choice', 'Alpha Choice'],
    ['prose naming no option', 'I recommend Alpha because it is safer.', undefined],
    ['null', null, undefined],
    ['absent', undefined, undefined],
  ])('accepts a %s recommendation', (_name, recommendation, expected) => {
    const parsed = WorkerQuestionSchema.parse(choice(recommendation))
    expect(parsed).toMatchObject({ kind: 'choice', question: 'Which option?' })
    expect(parsed.kind === 'choice' ? parsed.recommendation : undefined).toBe(expected)
  })

  const unanswerable: [string, WorkerQuestionInput][] = [
    ['empty question', { ...choice('Alpha Choice'), question: '' }],
    ['one option', { ...choice('Alpha Choice'), options: ['Alpha Choice'] }],
    [
      'duplicate normalized option names',
      { ...choice('Alpha Choice'), options: ['Alpha Choice', ' alpha  choice '] },
    ],
    [
      'score with one level',
      {
        kind: 'score',
        question: 'How much?',
        why: 'The threshold depends on the score.',
        levels: ['low'],
      },
    ],
    [
      'score with eleven levels',
      {
        kind: 'score',
        question: 'How much?',
        why: 'The threshold depends on the score.',
        levels: Array.from({ length: 11 }, (_, index) => String(index)),
      },
    ],
  ]

  test.each(unanswerable)('refuses %s', (_name, question) => {
    expect(realQuestions({ status: 'asking', questions: [question] })).toEqual([])
  })

  test('returns the canonical option name for a case-variant answer', () => {
    const question = WorkerQuestionSchema.parse(choice())
    expect(decodeAnswerValue(question, 'alpha choice')).toBe('Alpha Choice')
  })
})
