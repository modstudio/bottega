import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { hostedCollectLegs } from './collect.ts'
import { db, writeTransaction } from './db.ts'
import { pullHostedSendChanges } from './hosted-change-cache.ts'
import type { HostedSend } from './hosted-reports.ts'
import { HOSTED_SEND_CHANGES_CURSOR_KEY } from './hosted-send-change-family.ts'
import { cacheHostedSend } from './report-cache.ts'
import type { HostedSpaceChangePage } from './task-client.ts'

beforeEach(resetFixtureStore)

const at = '2026-10-11T12:00:00.000Z'
const sendId = '01990000-0000-7000-8000-000000001240'
const otherSendId = '01990000-0000-7000-8000-000000001241'
const options = { baseUrl: 'https://hub.example.test', token: 'session' } as const

const hostedSend = (overrides: Partial<HostedSend> = {}): HostedSend => ({
  id: sendId,
  at,
  window: 'day',
  recipients: '["one@example.test"]',
  projects: '["workshop"]',
  items: 1,
  status: 'sent',
  error: null,
  test: 0,
  created_at: at,
  machine: 'machine-one',
  recipient_details: [{ user_id: null, name: 'One', email: 'one@example.test' }],
  ...overrides,
})

const identity = {
  userId: 'user-one',
  activeSpaceId: 'space-one',
  memberships: [
    { spaceId: 'space-one', slug: 'one' },
    { spaceId: 'space-two', slug: 'two' },
  ],
  capabilities: { spaceChanges: true },
}

const changePage = (
  overrides: Partial<HostedSpaceChangePage> & Pick<HostedSpaceChangePage, 'next'>,
): HostedSpaceChangePage => ({
  head: 20,
  oldest: 1,
  more: false,
  resetRequired: false,
  changes: [],
  ...overrides,
})

type RouteOptions = {
  changes?: (after: string | null) => unknown | Response
  sends?: (cursor: string | null) => unknown | Response
  calls?: Array<{ path: string; space: string | null }>
}

const routeFetch =
  ({ changes, sends, calls = [] }: RouteOptions = {}) =>
  async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    calls.push({ path: url.pathname, space: new Headers(init?.headers).get('x-record-space') })
    if (url.pathname === '/v1/tasks/identity') return Response.json(identity)
    if (url.pathname === '/v1/changes') {
      expect(url.searchParams.get('tables')).toBe('hub_send')
      const body =
        changes?.(url.searchParams.get('after')) ??
        changePage({ next: Number(url.searchParams.get('after') ?? 0) })
      return body instanceof Response ? body : Response.json(body)
    }
    if (url.pathname === '/v1/sends') {
      const body = sends?.(url.searchParams.get('cursor')) ?? { sends: [], cursor: at }
      return body instanceof Response ? body : Response.json(body)
    }
    throw new Error(`unexpected route ${url.pathname}`)
  }

const cursor = () =>
  db()
    .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?')
    .get(`${HOSTED_SEND_CHANGES_CURSOR_KEY}.space-one`)?.value ?? null

const storeCursor = (value: string) =>
  writeTransaction((conn) => {
    conn
      .query(
        'INSERT INTO setting(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(`${HOSTED_SEND_CHANGES_CURSOR_KEY}.space-one`, value)
  })

const seed = (...rows: HostedSend[]) =>
  writeTransaction((conn) => {
    for (const row of rows) cacheHostedSend(conn, row)
  })

const pull = (fetch: (input: string, init?: RequestInit) => Promise<Response>) =>
  pullHostedSendChanges({ ...options, fetch })

test('first run reads the active-space head, full-pulls sends, and stores the head', async () => {
  const calls: Array<{ path: string; space: string | null }> = []
  const fetch = routeFetch({
    calls,
    changes: (after) => changePage({ head: 12, next: Number(after) }),
    sends: (timestampCursor) => {
      expect(timestampCursor).toBeNull()
      return { sends: [hostedSend()], cursor: at }
    },
  })

  const report = await pull(fetch)

  expect(cursor()).toBe('12')
  expect(db().query('SELECT 1 FROM send WHERE record_id=?').get(sendId)).not.toBeNull()
  expect(report?.spaces.map((space) => space.spaceId)).toEqual(['space-one'])
  expect(calls).toEqual([
    { path: '/v1/tasks/identity', space: null },
    { path: '/v1/changes', space: 'space-one' },
    { path: '/v1/sends', space: null },
    { path: '/v1/changes', space: 'space-one' },
  ])
})

test('first sync reads every send page beyond the former thousand-row limit', async () => {
  const firstPage = Array.from({ length: 1000 }, (_, index) => hostedSend({ id: `send-${index}` }))
  const fetch = routeFetch({
    changes: (after) => changePage({ head: 12, next: Number(after) }),
    sends: (timestampCursor) =>
      timestampCursor === null
        ? { sends: firstPage, cursor: 'page-one' }
        : { sends: [hostedSend({ id: 'send-1000' })], cursor: 'page-two' },
  })

  await pull(fetch)

  expect(db().query<{ count: number }, []>('SELECT count(*) count FROM send').get()?.count).toBe(
    1001,
  )
})

test('an identical upsert is a no-op and a sent-to-failed upsert records send evidence', async () => {
  storeCursor('12')
  seed(hostedSend(), hostedSend({ id: otherSendId }))
  const fetch = routeFetch({
    changes: () =>
      changePage({
        next: 14,
        changes: [
          { sequence: 13, table: 'hub_send', id: sendId, op: 'upsert', row: hostedSend() },
          {
            sequence: 14,
            table: 'hub_send',
            id: otherSendId,
            op: 'upsert',
            row: hostedSend({ id: otherSendId, status: 'failed' }),
          },
        ],
      }),
  })

  const report = await pull(fetch)

  expect(report).toMatchObject({ upsertsNoop: 1, upsertsChanged: 1 })
  expect(
    db()
      .query<{ status: string }, [string]>('SELECT status FROM send WHERE record_id=?')
      .get(otherSendId),
  ).toEqual({ status: 'failed' })
})

test('a pending log upsert is stored and a later sent upsert updates the same row', async () => {
  storeCursor('12')
  await pull(
    routeFetch({
      changes: () =>
        changePage({
          next: 13,
          changes: [
            {
              sequence: 13,
              table: 'hub_send',
              id: sendId,
              op: 'upsert',
              row: hostedSend({ status: 'pending' }),
            },
          ],
        }),
    }),
  )
  expect(db().query<{ status: string }, []>('SELECT status FROM send').get()).toEqual({
    status: 'pending',
  })

  await pull(
    routeFetch({
      changes: () =>
        changePage({
          next: 14,
          changes: [
            {
              sequence: 14,
              table: 'hub_send',
              id: sendId,
              op: 'upsert',
              row: hostedSend({ status: 'sent' }),
            },
          ],
        }),
    }),
  )

  expect(db().query('SELECT record_id,status FROM send').all()).toEqual([
    { record_id: sendId, status: 'sent' },
  ])
})

test('a recipient change arrives as an upsert of its send', async () => {
  storeCursor('12')
  seed(hostedSend())
  const recipients = '["one@example.test","two@example.test"]'
  const fetch = routeFetch({
    changes: () =>
      changePage({
        next: 13,
        changes: [
          {
            sequence: 13,
            table: 'hub_send',
            id: sendId,
            op: 'upsert',
            row: hostedSend({ recipients }),
          },
        ],
      }),
  })

  const report = await pull(fetch)

  expect(report?.upsertsChanged).toBe(1)
  expect(db().query<{ recipients: string }, []>('SELECT recipients FROM send').get()).toEqual({
    recipients,
  })
})

test('an active-space hard delete removes the machine send', async () => {
  storeCursor('12')
  seed(hostedSend())
  const fetch = routeFetch({
    changes: () =>
      changePage({
        next: 13,
        changes: [{ sequence: 13, table: 'hub_send', id: sendId, op: 'delete' }],
      }),
  })

  const report = await pull(fetch)

  expect(db().query('SELECT 1 FROM send WHERE record_id=?').get(sendId)).toBeNull()
  expect(report).toMatchObject({ deletesApplied: 1, deletesSkipped: 0 })
})

test('a failed send family leaves both earlier family results intact', async () => {
  const fetch = routeFetch({
    changes: () => Response.json({ error: 'offline' }, { status: 503 }),
    sends: () => ({ sends: [hostedSend()], cursor: at }),
  })
  const emptyReport = {
    upsertsChanged: 0,
    upsertsNoop: 0,
    deletesApplied: 0,
    deletesSkipped: 0,
    resets: 0,
    spaces: [],
  }
  const results = await hostedCollectLegs(undefined, {
    correctIntervals: () => {},
    changes: async () => emptyReport,
    noteChanges: async () => emptyReport,
    sendChanges: () => pull(fetch),
  })

  expect(results.find((result) => result.source === 'hosted task changes')?.ok).toBeTrue()
  expect(results.find((result) => result.source === 'hosted note changes')?.ok).toBeTrue()
  expect(results.find((result) => result.source === 'hosted send changes')).toMatchObject({
    ok: false,
    error:
      'hosted send change pulls failed: space-one: hosted hub refused the request (503): offline',
  })
  expect(cursor()).toBeNull()
})
