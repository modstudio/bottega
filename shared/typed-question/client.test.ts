import { describe, expect, test } from 'bun:test'
import { askTypedQuestionClient } from './client.ts'
import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from './registry.ts'

const FIXTURE_QUESTION = {
  id: 'spec_unsettled',
  version: 1,
  type: 'noul',
  threshold: 0.5,
  instructions: 'Judge whether the fixture state leaves a choice open.',
} as const satisfies NoulQuestion

const resolve = async () => ({ TYPESAFE_KEY: 'fixture-secret' })

test('sends the declared noul question and parses its probability', async () => {
  let request: { url: string; init: RequestInit } | null = null
  const result = await askTypedQuestionClient(FIXTURE_QUESTION, 'choose one', {
    resolve,
    fetch: async (url, init) => {
      request = { url, init }
      return Response.json({
        answers: { spec_unsettled: { noul: 0.91 } },
        model: 'jev-served',
        usage: { input_tokens: 42 },
      })
    },
  })

  expect(result).toMatchObject({
    kind: 'answer',
    answer: { noul: 0.91 },
    model: 'jev-served',
    inputTokens: 42,
  })
  expect(request).not.toBeNull()
  expect(request!.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(request!.init.method).toBe('POST')
  expect(new Headers(request!.init.headers).get('Authorization')).toBe('Bearer fixture-secret')
  expect(request!.init.signal).toBeInstanceOf(AbortSignal)
  expect(JSON.parse(String(request!.init.body))).toEqual({
    model: 'jev-latest',
    state: 'choose one',
    questions: {
      spec_unsettled: {
        type: 'noul',
        instructions: FIXTURE_QUESTION.instructions,
      },
    },
  })
})

test('sends criteria and parses a choice answer', async () => {
  const question: ChoiceQuestion = {
    id: 'destination',
    version: 3,
    type: 'choice',
    instructions: 'Choose a destination.',
    criteria: { local: 'Stays here', hosted: 'Moves to the record' },
    threshold: 0.8,
  }
  let sent: unknown
  const result = await askTypedQuestionClient(
    question,
    { text: 'portable evidence' },
    {
      resolve,
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init.body))
        return Response.json({
          answers: {
            destination: {
              choice: 'hosted',
              confidence: 0.88,
              probabilities: { local: 0.12, hosted: 0.88 },
            },
          },
          model: 'jev-choice',
          usage: { input_tokens: 18 },
        })
      },
    },
  )

  expect(sent).toEqual({
    model: 'jev-latest',
    state: { text: 'portable evidence' },
    questions: {
      destination: {
        type: 'choice',
        instructions: 'Choose a destination.',
        criteria: question.criteria,
      },
    },
  })
  expect(result).toMatchObject({
    kind: 'answer',
    answer: {
      choice: 'hosted',
      confidence: 0.88,
      probabilities: { local: 0.12, hosted: 0.88 },
    },
  })
})

describe('backoff response', () => {
  test('retries 429 once and then returns the failure class', async () => {
    let calls = 0
    const result = await askTypedQuestionClient(FIXTURE_QUESTION, 'state', {
      resolve,
      fetch: async () => {
        calls += 1
        return new Response('', { status: 429 })
      },
    })

    expect(calls).toBe(2)
    expect(result).toMatchObject({ kind: 'error', error: 'http_429' })
  })
})

test('sends score levels and parses a score answer', async () => {
  const question: ScoreQuestion = {
    id: 'level',
    version: 1,
    type: 'score',
    instructions: 'Score it.',
    criteria: ['low', 'high'],
    threshold: 0.9,
  }
  let sent: { questions: { level: { criteria: string[] } } } | undefined
  const result = await askTypedQuestionClient(question, 'state', {
    resolve,
    fetch: async (_url, init) => {
      sent = JSON.parse(String(init.body)) as typeof sent
      return Response.json({
        answers: {
          level: {
            score: 1,
            confidence: 0.9,
            legend: 'high',
            probabilities: { '0': 0.1, '1': 0.9 },
          },
        },
        model: 'jev-score',
        usage: { input_tokens: 5 },
      })
    },
  })
  expect(sent?.questions.level.criteria).toEqual(['low', 'high'])
  expect(result).toMatchObject({ kind: 'answer', answer: { score: 1, confidence: 0.9 } })
})
