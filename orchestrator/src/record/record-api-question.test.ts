import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import {
  encodeRecordChangeCursor,
  type RecordChangeCursor,
} from '../../../shared/record/record-changes.ts'
import {
  type RecordQuestionRouteDeps,
  registerRecordQuestionRoutes,
} from './record-api-question.ts'
import type { RecordIdentity } from './record-auth.ts'
import { UnboundedQuestionRulingsError } from './record-question-contract.ts'
import { readRecordQuestions } from './record-question-read.ts'

const tenant = {
  url: 'postgres://record.test',
  userId: '01990000-0000-7000-8000-000000002001',
  spaceId: '01990000-0000-7000-8000-000000002002',
  spaceIds: ['01990000-0000-7000-8000-000000002002'],
}

function app(deps: RecordQuestionRouteDeps) {
  const api = new Hono<{
    Variables: { identity: RecordIdentity; destinationSpaceId?: string }
  }>()
  registerRecordQuestionRoutes(api, deps, {
    scope: () => tenant,
    noSpace: () => new Response(null, { status: 409 }),
  })
  return api
}

test('hosted rulings decode opaque cursors and malformed cursors give a fresh-cursor remedy', async () => {
  const cursor = { xid: 12n, seq: 34n }
  let received: RecordChangeCursor | undefined
  const api = app({
    readQuestions: async (input) => {
      if (
        input.read === 'rulings' &&
        input.changedAfter &&
        !('questionNumber' in input.changedAfter)
      )
        received = input.changedAfter
      return { items: [], cursor: encodeRecordChangeCursor(cursor), more: false, reset: false }
    },
  })
  const response = await api.request(
    `/v1/questions?read=rulings&changedAfter=${encodeRecordChangeCursor(cursor)}`,
  )
  expect(response.status).toBe(200)
  expect(received).toEqual(cursor)

  const malformed = await api.request('/v1/questions?read=rulings&changedAfter=bad')
  expect(malformed.status).toBe(422)
  expect(await malformed.json()).toEqual({
    error: 'record change cursor is malformed',
    remedy: 'retry without changedAfter to get a fresh cursor',
  })
})

test('hosted rulings refuse combining a change cursor with a limit', async () => {
  const cursor = encodeRecordChangeCursor({ xid: 12n, seq: 34n })
  const response = await app({ readQuestions: async () => ({ items: [] }) }).request(
    `/v1/questions?read=rulings&changedAfter=${cursor}&limit=1`,
  )
  expect(response.status).toBe(422)
  expect(await response.json()).toEqual({
    error: 'limit cannot be combined with changedAfter',
    remedy: 'drop limit; follow more to page',
  })
})

test('hosted rulings refuse an unbounded history read and serve every bounded form', async () => {
  const reads: string[] = []
  const api = app({
    readQuestions: async (input) => {
      if (input.read === 'rulings')
        reads.push(
          input.since !== undefined
            ? 'since'
            : input.limit !== undefined
              ? 'limit'
              : input.changedAfter !== undefined
                ? 'changedAfter'
                : 'unbounded',
        )
      if (
        input.read === 'rulings' &&
        input.since === undefined &&
        input.limit === undefined &&
        input.changedAfter === undefined
      )
        throw new UnboundedQuestionRulingsError()
      return { items: [], cursor: encodeRecordChangeCursor({ xid: 1n, seq: 1n }), more: false }
    },
  })
  const refused = await api.request('/v1/questions?read=rulings')
  expect(refused.status).toBe(422)
  expect(await refused.json()).toEqual({
    error: 'unbounded question ruling history reads are refused',
    remedy:
      'use by-id, by-number, for-run, for-runs, for-session, open-for-cursors, open-for-tasks, or unlinked-workflow for a targeted read; otherwise page rulings with limit and changedAfter',
  })
  expect(
    (await api.request('/v1/questions?read=rulings&since=2026-11-15T12%3A00%3A00.000Z')).status,
  ).toBe(200)
  expect((await api.request('/v1/questions?read=rulings&limit=1')).status).toBe(200)
  const cursor = encodeRecordChangeCursor({ xid: 1n, seq: 1n })
  expect((await api.request(`/v1/questions?read=rulings&changedAfter=${cursor}`)).status).toBe(200)
  expect(reads).toEqual(['unbounded', 'since', 'limit', 'changedAfter'])
})

test('hosted read service refuses unbounded ruling materialization', async () => {
  expect(readRecordQuestions({ ...tenant, read: 'rulings', kind: 'all' })).rejects.toBeInstanceOf(
    UnboundedQuestionRulingsError,
  )
})

test('hosted question reads other than rulings still refuse changedAfter', async () => {
  const response = await app({ readQuestions: async () => ({ items: [] }) }).request(
    '/v1/questions?read=waiting&changedAfter=opaque',
  )
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({ remedy: expect.stringContaining('rulings read') })
})

test('a destinationless question by-id miss returns the membership-safe refusal', async () => {
  const response = await app({ readQuestions: async () => ({ items: [] }) }).request(
    '/v1/questions?read=by-id&ids=00000000-0000-4000-8000-000000000001',
  )
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({
    error: 'not visible in your record spaces (1 memberships)',
    remedy:
      'the row is in a space you are not a member of, or it does not exist; join its space or check the id',
  })
})

test('invalid direct question writes name the failing body path', async () => {
  const response = await app({ writeQuestion: async () => ({ applied: true }) }).request(
    '/v1/questions/answer',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: '00000000-0000-4000-8000-000000000001',
        question: {
          id: '00000000-0000-4000-8000-000000000002',
          runId: null,
          workflowKey: null,
          workflowTaskId: null,
          workflowCursorRecordId: null,
          projectId: null,
          machineId: '00000000-0000-4000-8000-000000000003',
          revision: 1,
          askedAt: 'not-a-timestamp',
          question: 'Proceed?',
          options: null,
          recommendation: null,
          why: null,
          askedVia: null,
          kind: null,
          typedOptions: null,
          criteria: null,
          levels: null,
          answer: null,
          answerValue: null,
          answerBasis: null,
          answeredAt: null,
          answeredBy: null,
          answeredByName: null,
          answeredByKind: null,
          answererKind: null,
          answerChannel: null,
          jevPick: null,
          jevConfidence: null,
          jevProbabilities: null,
          jevModel: null,
          jevInputTokens: null,
          jevError: null,
          jevAgreed: null,
          jevQuestionVersion: null,
          jevFits: null,
          jevOrderFlipped: null,
          awaitingOperatorAt: null,
          relayedBy: null,
          overturnedAt: null,
          overturnedBy: null,
          overturnedByName: null,
          overturnReason: null,
          replacement: null,
          filedAs: null,
          filedRef: null,
          filedRecordId: null,
          filedLabel: null,
          filedAt: null,
          closedAt: null,
          closeReason: null,
          createdAt: '2026-11-16T20:09:29.002Z',
          updatedAt: '2026-11-16T20:09:29.002Z',
        },
        audit: {
          action: 'answer',
          actorSession: null,
          at: '2026-11-16T20:09:29.002Z',
          reason: null,
        },
      }),
    },
  )
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: expect.stringContaining('question.askedAt:'),
  })
})

test('an unknown direct question write intent is named in the refusal', async () => {
  const response = await app({ writeQuestion: async () => ({ applied: true }) }).request(
    '/v1/questions/answerr',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  )
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: expect.stringContaining('(intent):') })
})
