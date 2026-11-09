import { describe, expect, test } from 'bun:test'
import { askTypedQuestionClient, askTypedQuestionsClient } from './client.ts'
import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from './registry.ts'

const FIXTURE_QUESTION = {
  id: 'spec_unsettled',
  version: 1,
  type: 'noul',
  threshold: 0.5,
  instructions: 'Judge whether the fixture state leaves a choice open.',
} as const satisfies NoulQuestion

const resolve = async () => ({ TYPESAFE_KEY: 'fixture-secret' })
const missingCredential = async () => ({ kind: 'missing' }) as const

test('typed credential wins over a present legacy key', async () => {
  let authorization: string | null = null
  const result = await askTypedQuestionClient(FIXTURE_QUESTION, 'state', {
    resolveCredential: async () => ({ kind: 'resolved', value: 'typed-secret' }),
    resolve: async () => {
      throw new Error('legacy key must not be read')
    },
    fetch: async (_url, init) => {
      authorization = new Headers(init.headers).get('Authorization')
      return Response.json({
        answers: { spec_unsettled: { noul: 0.7 } },
        model: 'jev-served',
        usage: { input_tokens: 1 },
      })
    },
  })
  expect(result.kind).toBe('answer')
  expect(String(authorization)).toBe('Bearer typed-secret')
})

test('missing typed credential falls back to the legacy key', async () => {
  let legacyReads = 0
  let authorization: string | null = null
  const result = await askTypedQuestionClient(FIXTURE_QUESTION, 'state', {
    resolveCredential: missingCredential,
    resolve: async () => {
      legacyReads += 1
      return { TYPESAFE_KEY: 'legacy-secret' }
    },
    fetch: async (_url, init) => {
      authorization = new Headers(init.headers).get('Authorization')
      return Response.json({
        answers: { spec_unsettled: { noul: 0.7 } },
        model: 'jev-served',
        usage: { input_tokens: 1 },
      })
    },
  })
  expect(result.kind).toBe('answer')
  expect(legacyReads).toBe(1)
  expect(String(authorization)).toBe('Bearer legacy-secret')
})

test('credential resolution failure returns key_resolution without reading the legacy key', async () => {
  let legacyReads = 0
  const result = await askTypedQuestionClient(FIXTURE_QUESTION, 'state', {
    resolveCredential: async () => {
      throw new Error('membership refused')
    },
    resolve: async () => {
      legacyReads += 1
      return { TYPESAFE_KEY: 'legacy-secret' }
    },
    fetch: async () => {
      throw new Error('request must not be sent')
    },
  })
  expect(result).toMatchObject({ kind: 'error', error: 'key_resolution' })
  expect(legacyReads).toBe(0)
})

test('missing typed and legacy credentials returns missing-key', async () => {
  const result = await askTypedQuestionClient(FIXTURE_QUESTION, 'state', {
    resolveCredential: missingCredential,
    resolve: async () => ({ TYPESAFE_KEY: undefined }),
    fetch: async () => {
      throw new Error('request must not be sent')
    },
  })
  expect(result).toEqual({ kind: 'missing-key' })
})

test('sends the declared noul question and parses its probability', async () => {
  let request: { url: string; init: RequestInit } | null = null
  const result = await askTypedQuestionClient(FIXTURE_QUESTION, 'choose one', {
    resolveCredential: missingCredential,
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
    model: 'jev-1.14.0',
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
      resolveCredential: missingCredential,
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
    model: 'jev-1.14.0',
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
  test('honors retry-after-ms before retrying', async () => {
    let calls = 0
    const delays: number[] = []
    const result = await askTypedQuestionClient(FIXTURE_QUESTION, 'state', {
      resolveCredential: missingCredential,
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
      resolveCredential: missingCredential,
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
      resolveCredential: missingCredential,
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
    resolveCredential: missingCredential,
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

test('batches every id, retries once, and drops only an unparsable answer', async () => {
  const other = { ...FIXTURE_QUESTION, id: 'other' }
  let calls = 0
  let sent: unknown
  const result = await askTypedQuestionsClient(
    [FIXTURE_QUESTION, other],
    { shared: true },
    {
      resolveCredential: missingCredential,
      resolve,
      fetch: async (_url, init) => {
        calls += 1
        sent = JSON.parse(String(init.body))
        if (calls === 1) return new Response('', { status: 503 })
        return Response.json({
          answers: { spec_unsettled: { noul: 0.8 }, other: { noul: 'bad' } },
          model: 'jev-batch',
          usage: { input_tokens: 9 },
        })
      },
      sleep: async () => {},
    },
  )
  expect(calls).toBe(2)
  expect(Object.keys((sent as { questions: object }).questions)).toEqual([
    'spec_unsettled',
    'other',
  ])
  expect(result).toMatchObject({
    kind: 'answer',
    answers: { spec_unsettled: { noul: 0.8 } },
    inputTokens: 9,
  })
  if (result.kind === 'answer') expect(result.answers.other).toBeUndefined()
})
