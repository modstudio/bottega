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
      if (input.read === 'rulings') received = input.changedAfter
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

test('hosted question reads other than rulings still refuse changedAfter', async () => {
  const response = await app({ readQuestions: async () => ({ items: [] }) }).request(
    '/v1/questions?read=waiting&changedAfter=opaque',
  )
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({ remedy: expect.stringContaining('rulings read') })
})
