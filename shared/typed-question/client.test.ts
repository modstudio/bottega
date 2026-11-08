import { describe, expect, test } from 'bun:test'
import { askTypedQuestionClient, JEV_MODEL } from './client.ts'
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
    model: JEV_MODEL,
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
    model: JEV_MODEL,
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
  test('honours retry-after-ms before retrying', async () => {
    let calls = 0
    const delays: number[] = []
    const result = await askTypedQuestionClient(FIXTURE_QUESTION, 'state', {
      resolve,
      fetch: async () => {
        calls += 1
        return calls === 1
          ? new Response('', { status: 429, headers: { 'retry-after-ms': '1234' } })
          : Response.json({
              answers: { spec_unsettled: { noul: 0.7 } },
              model: 'jev-served',
              usage: { input_tokens: 1 },
            })
      },
      sleep: async (ms) => {
        delays.push(ms)
      },
      random: () => 0,
    })

    expect(calls).toBe(2)
    expect(delays).toEqual([1234])
    expect(result.kind).toBe('answer')
  })

  test('exhaustion returns the last retryable status', async () => {
    const statuses = [408, 529, 503]
    const result = await askTypedQuestionClient(FIXTURE_QUESTION, 'state', {
      resolve,
      fetch: async () => new Response('', { status: statuses.shift()! }),
      sleep: async () => {},
      random: () => 0.5,
    })
    expect(statuses).toHaveLength(0)
    expect(result).toMatchObject({ kind: 'error', error: 'http_503' })
  })

  test('does not retry a non-retryable status', async () => {
    let calls = 0
    const result = await askTypedQuestionClient(FIXTURE_QUESTION, 'state', {
      resolve,
      fetch: async () => {
        calls += 1
        return new Response('', { status: 400 })
      },
      sleep: async () => {
        throw new Error('should not sleep')
      },
    })
    expect(calls).toBe(1)
    expect(result).toMatchObject({ kind: 'error', error: 'http_400' })
  })
})

test('sends score levels and parses a score answer', async () => {
  const question: ScoreQuestion = {
    id: 'level',
    version: 1,
    type: 'score',
    instructions: 'Score it.',
    criteria: ['low', 'medium', 'high'],
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
            score: 1.43,
            confidence: 0.9,
            legend: { '0': 'low', '1': 'medium', '2': 'high' },
            probabilities: { '0': 0, '1': 0.57, '2': 0.43 },
          },
        },
        model: 'jev-score',
        usage: { input_tokens: 5 },
      })
    },
  })
  expect(sent?.questions.level.criteria).toEqual(['low', 'medium', 'high'])
  expect(result).toMatchObject({ kind: 'answer', answer: { score: 1.43, confidence: 0.9 } })
})
