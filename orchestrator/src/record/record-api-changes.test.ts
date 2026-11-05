import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { encodeRecordChangeCursor } from '../../../shared/record/record-changes.ts'
import { type RecordChangeRouteDeps, registerRecordChangeRoute } from './record-api-changes.ts'
import type { RecordIdentity } from './record-auth.ts'

const spaceA = '01990000-0000-7000-8000-000000002001'
const spaceB = '01990000-0000-7000-8000-000000002002'
const spaceC = '01990000-0000-7000-8000-000000002003'
const user = '01990000-0000-7000-8000-000000002004'
const cursor = { xid: 12n, seq: 34n }
const identity = {
  user: { id: user },
  personalSpaceId: spaceA,
  activeSpaceId: spaceA,
  memberships: [{ space_id: spaceA }, { space_id: spaceB }],
} as RecordIdentity

function app(deps: Partial<RecordChangeRouteDeps>) {
  const api = new Hono<{ Variables: { identity: RecordIdentity } }>()
  api.use('*', async (context, next) => {
    context.set('identity', identity)
    await next()
  })
  registerRecordChangeRoute(api, {
    readChanges: async () => ({ resetRequired: false, cursor, lag: 0, more: false, changes: [] }),
    waitForRecordChange: async () => {},
    ...deps,
  })
  return api
}

test('record changes reset without a cursor and reject a malformed cursor', async () => {
  const reset = app({
    readChanges: async () => ({ resetRequired: true, horizon: cursor, cursor, lag: 0 }),
  })
  const response = await reset.request('/v1/changes')
  expect(response.status).toBe(410)
  expect(await response.json()).toMatchObject({
    reset: true,
    cursor: encodeRecordChangeCursor(cursor),
  })
  expect((await app({}).request('/v1/changes?after=bad')).status).toBe(400)
})

test('record changes bind every membership and preserve two-space rows', async () => {
  let spaces: string[] = []
  const response = await app({
    readChanges: async (input) => {
      spaces = input.spaceIds
      return {
        resetRequired: false,
        cursor,
        lag: 0,
        more: false,
        changes: [
          { table: 'doc', id: 'a', space: spaceA, op: 'upsert', row: { id: 'a' } },
          { table: 'project', id: 'b', space: spaceB, op: 'upsert', row: { id: 'b' } },
        ],
      }
    },
  }).request(`/v1/changes?after=${encodeRecordChangeCursor(cursor)}`)
  expect(spaces).toEqual([spaceA, spaceB])
  const body = (await response.json()) as { changes: Array<{ space: string }> }
  expect(body.changes.map((change) => change.space)).toEqual([spaceA, spaceB])
  expect(body.changes.some((change) => change.space === spaceC)).toBe(false)
})

test('record changes wake early and return empty when the wait expires', async () => {
  let reads = 0
  const early = await app({
    readChanges: async () => ({
      resetRequired: false,
      cursor,
      lag: 0,
      more: false,
      changes: ++reads === 1 ? [] : [{ table: 'doc', id: 'a', space: spaceA, op: 'delete' }],
    }),
    waitForRecordChange: async () => {},
  }).request(`/v1/changes?after=${encodeRecordChangeCursor(cursor)}&wait=30`)
  expect(((await early.json()) as { changes: unknown[] }).changes).toHaveLength(1)

  const empty = await app({
    waitForRecordChange: async () => {
      await new Promise((resolve) => setTimeout(resolve, 2))
    },
  }).request(`/v1/changes?after=${encodeRecordChangeCursor(cursor)}&wait=0`)
  expect(((await empty.json()) as { changes: unknown[] }).changes).toEqual([])
})
