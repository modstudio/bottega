import { afterAll, beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { pullHostedChanges } from './hosted-change-cache.ts'
import type { HostedSend } from './hosted-reports.ts'
import { cacheHostedSend } from './report-cache.ts'

const originalRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL

beforeEach(() => {
  resetFixtureStore()
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
})
afterAll(() => {
  if (originalRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = originalRecordApiUrl
})

const options = { baseUrl: 'https://hub.example.test', token: 'session' } as const
const registered = [
  { name: 'one', settings: { space: 'one' } },
  { name: 'two', settings: { space: 'two' } },
]
const identity = {
  userId: 'user-one',
  activeSpaceId: 'space-one',
  memberships: [
    { spaceId: 'space-one', slug: 'one' },
    { spaceId: 'space-two', slug: 'two' },
  ],
  capabilities: {
    recordChanges: true,
    projectNoteCounters: true,
    targetSpaceNotes: true,
  },
}
const at = '2026-10-09T12:00:00.000Z'
const sendId = '01990000-0000-7000-8000-000000001260'
const hostedSend = (overrides: Partial<HostedSend> = {}): HostedSend => ({
  id: sendId,
  at,
  window: 'day',
  recipients: '["one@example.test"]',
  projects: '["one"]',
  items: 1,
  status: 'sent',
  error: null,
  test: 0,
  created_at: at,
  machine: 'machine-one',
  recipient_details: [{ user_id: null, name: 'One', email: 'one@example.test' }],
  ...overrides,
})

function seedFeed(cursor = 'before') {
  writeTransaction((conn) => {
    conn
      .query('INSERT INTO setting(key,value) VALUES (?,?)')
      .run('collect.hosted-record-changes.cursor', cursor)
    conn.query('INSERT INTO setting(key,value) VALUES (?,?)').run(
      'collect.hosted-record-changes.spaces',
      JSON.stringify({
        task: ['space-one', 'space-two'],
        note: ['space-one', 'space-two'],
        send: ['space-one'],
      }),
    )
  })
}

const page = (cursor: string, changes: unknown[]) =>
  Response.json({ changes, cursor, lag: 0, more: false })
const route = (feed: () => Response) => async (input: string) => {
  const url = new URL(input)
  if (url.pathname === '/v1/whoami')
    return Response.json({
      user: { id: 'user-one' },
      activeSpaceId: 'space-one',
      personalSpaceId: 'space-one',
      memberships: identity.memberships,
    })
  if (url.pathname === '/v1/tasks/identity') return Response.json(identity)
  if (url.pathname === '/v1/changes') return feed()
  throw new Error(`unexpected route ${url.pathname}`)
}

test('send full pull uses personal space when the active space differs', async () => {
  writeTransaction((conn) => {
    conn
      .query('INSERT INTO setting(key,value) VALUES (?,?)')
      .run('collect.hosted-record-changes.cursor', 'before')
    conn.query('INSERT INTO setting(key,value) VALUES (?,?)').run(
      'collect.hosted-record-changes.spaces',
      JSON.stringify({
        task: ['space-active', 'space-one', 'space-two'],
        note: ['space-active', 'space-one', 'space-two'],
        send: [],
      }),
    )
  })
  const requested: Array<{ path: string; space: string | null }> = []
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    if (url.pathname === '/v1/whoami')
      return Response.json({
        user: { id: 'user-one' },
        activeSpaceId: 'space-active',
        personalSpaceId: 'space-personal',
        memberships: [],
      })
    if (url.pathname === '/v1/tasks/identity')
      return Response.json({ ...identity, activeSpaceId: 'space-active' })
    if (url.pathname === '/v1/sends') {
      requested.push({
        path: url.pathname,
        space: new Headers(init?.headers).get('x-record-space'),
      })
      return Response.json({ sends: [], cursor: null, more: false })
    }
    if (url.pathname === '/v1/changes') return page('after', [])
    throw new Error(`unexpected route ${url.pathname}`)
  }

  await pullHostedChanges({ ...options, fetch, registeredProjects: registered })

  expect(requested).toEqual([{ path: '/v1/sends', space: 'space-personal' }])
})
const sendReport = (report: Awaited<ReturnType<typeof pullHostedChanges>>) =>
  report.families.find((entry) => entry.name === 'send')!.report

test('record-feed send upserts count no-ops, retain pending rows, and record state changes', async () => {
  seedFeed()
  const otherSendId = '01990000-0000-7000-8000-000000001261'
  writeTransaction((conn) => {
    cacheHostedSend(conn, hostedSend())
    cacheHostedSend(conn, hostedSend({ id: otherSendId }))
  })
  const first = await pullHostedChanges({
    ...options,
    fetch: route(() =>
      page('first', [
        { table: 'hub_send', id: sendId, space: 'space-one', op: 'upsert', row: hostedSend() },
        {
          table: 'hub_send',
          id: otherSendId,
          space: 'space-one',
          op: 'upsert',
          row: hostedSend({ id: otherSendId, status: 'failed' }),
        },
      ]),
    ),
    registeredProjects: registered,
  })
  expect(sendReport(first)).toMatchObject({ upsertsNoop: 1, upsertsChanged: 1 })
  expect(db().query('SELECT status FROM send WHERE record_id=?').get(otherSendId)).toEqual({
    status: 'failed',
  })

  resetFixtureStore()
  seedFeed()
  await pullHostedChanges({
    ...options,
    fetch: route(() =>
      page('pending', [
        {
          table: 'hub_send',
          id: sendId,
          space: 'space-one',
          op: 'upsert',
          row: hostedSend({ status: 'pending' }),
        },
      ]),
    ),
    registeredProjects: registered,
  })
  await pullHostedChanges({
    ...options,
    fetch: route(() =>
      page('sent', [
        {
          table: 'hub_send',
          id: sendId,
          space: 'space-one',
          op: 'upsert',
          row: hostedSend({ status: 'sent' }),
        },
      ]),
    ),
    registeredProjects: registered,
  })
  expect(db().query('SELECT record_id,status FROM send').all()).toEqual([
    { record_id: sendId, status: 'sent' },
  ])
})

test('record-feed send recipient upserts and active-space hard deletes apply', async () => {
  seedFeed()
  writeTransaction((conn) => cacheHostedSend(conn, hostedSend()))
  const recipients = '["one@example.test","two@example.test"]'
  const changed = await pullHostedChanges({
    ...options,
    fetch: route(() =>
      page('changed', [
        {
          table: 'hub_send',
          id: sendId,
          space: 'space-one',
          op: 'upsert',
          row: hostedSend({ recipients }),
        },
      ]),
    ),
    registeredProjects: registered,
  })
  expect(sendReport(changed).upsertsChanged).toBe(1)
  expect(db().query('SELECT recipients FROM send').get()).toEqual({ recipients })
  const removed = await pullHostedChanges({
    ...options,
    fetch: route(() =>
      page('removed', [{ table: 'hub_send', id: sendId, space: 'space-one', op: 'delete' }]),
    ),
    registeredProjects: registered,
  })
  expect(db().query('SELECT 1 FROM send').get()).toBeNull()
  expect(sendReport(removed)).toMatchObject({ deletesApplied: 1, deletesSkipped: 0 })
})
