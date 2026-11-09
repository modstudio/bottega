import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { askTypedQuestionClient } from '../../../shared/typed-question/client.ts'
import type { TypedQuestion } from '../../../shared/typed-question/registry.ts'
import { SPEC_UNSETTLED_QUESTION } from './spec-unsettled-question.ts'
import type { TypedQuestionAnswerRow } from './typed-question-answer-store.ts'
import { askTypedQuestion } from './typed-question-service.ts'

function fixture(input: {
  resolveCredential?: () => Promise<{ kind: 'resolved'; value: string } | { kind: 'missing' }>
  fetch?: (input: string, init: RequestInit) => Promise<Response>
}) {
  const rows: TypedQuestionAnswerRow[] = []
  const resolveCredential =
    input.resolveCredential ??
    (async () => ({ kind: 'resolved' as const, value: 'fixture-secret' }))
  const fetch = input.fetch ?? (async () => new Response('', { status: 500 }))
  return {
    rows,
    dependencies: {
      ask: (question: TypedQuestion, state: string | Record<string, unknown>) =>
        askTypedQuestionClient(question, state, {
          resolveCredential,
          fetch,
        }),
      record: (row: TypedQuestionAnswerRow) => {
        rows.push(row)
      },
    },
  }
}

const input = {
  question: SPEC_UNSETTLED_QUESTION,
  subjectKind: 'spec',
  subjectRef: '0123456789abcdef',
  state: 'A spec with an unresolved choice.',
} as const

test('a missing key returns no answer and records nothing', async () => {
  const f = fixture({ resolveCredential: async () => ({ kind: 'missing' }) })

  expect(await askTypedQuestion(input, f.dependencies)).toBeNull()
  expect(f.rows).toEqual([])
})

describe.each([
  {
    name: 'timeout',
    error: 'timeout',
    fetch: async () => {
      throw new DOMException('fixture timeout', 'TimeoutError')
    },
  },
  {
    name: '500 response',
    error: 'http_500',
    fetch: async () => new Response('private response body', { status: 500 }),
  },
  {
    name: 'garbage body',
    error: 'unparsable_body',
    fetch: async () => new Response('not-json', { status: 200 }),
  },
])('$name', ({ error, fetch }) => {
  test('fails open and records only the failure class', async () => {
    const f = fixture({ fetch })

    expect(await askTypedQuestion(input, f.dependencies)).toBeNull()
    expect(f.rows).toHaveLength(1)
    expect(f.rows[0]).toEqual({
      questionId: 'spec_unsettled',
      questionVersion: 1,
      subjectKind: 'spec',
      subjectRef: '0123456789abcdef',
      stateSha: createHash('sha256').update(input.state).digest('hex'),
      answerJson: null,
      model: null,
      inputTokens: null,
      latencyMs: expect.any(Number),
      error,
    })
    expect(JSON.stringify(f.rows)).not.toContain('private response body')
  })
})

test('records a successful answer and returns it', async () => {
  const f = fixture({
    fetch: async () =>
      Response.json({
        answers: { spec_unsettled: { noul: 0.9 } },
        model: 'jev-served',
        usage: { input_tokens: 31 },
      }),
  })

  expect(await askTypedQuestion(input, f.dependencies)).toEqual({ noul: 0.9 })
  expect(f.rows[0]).toMatchObject({
    answerJson: JSON.stringify({ noul: 0.9 }),
    model: 'jev-served',
    inputTokens: 31,
    error: null,
  })
})
