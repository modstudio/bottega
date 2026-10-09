import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { writeTransaction } from './db.ts'
import { syncEvidence } from './sync.ts'

beforeEach(resetFixtureStore)

const dayId = '33333333-3333-4333-8333-333333333333'

function insertDay(id = dayId, day = '2026-10-08', collectedAt = `${day}T12:00:00.000Z`) {
  writeTransaction((conn) =>
    conn
      .query(
        `INSERT INTO day (record_id,day,claude_tokens,messages,collected_at)
         VALUES (?,?,?,?,?)`,
      )
      .run(id, day, 42, 2, collectedAt),
  )
}

function insertThreeDays() {
  insertDay('11111111-1111-4111-8111-111111111111', '2026-10-06')
  insertDay('22222222-2222-4222-8222-222222222222', '2026-10-07')
  insertDay()
}

function syncFetch(writes: Record<string, unknown>[], dayRecordId = true) {
  return async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/tasks/identity'))
      return Response.json({
        userId: 'user-1',
        activeSpaceId: 'space-active',
        memberships: [{ spaceId: 'space-active', slug: 'active' }],
        capabilities: {
          targetSpaceIntervalEvidence: true,
          intervalRecordId: true,
          dayRecordId,
        },
      })
    writes.push({
      method: init?.method ?? 'GET',
      recordSpace: new Headers(init?.headers).get('x-record-space'),
      body: JSON.parse(String(init?.body)),
    })
    return Response.json({ ok: true })
  }
}

test('refuses to push days to a server without day record id support', async () => {
  insertDay()
  const writes: Record<string, unknown>[] = []

  await expect(
    syncEvidence({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: syncFetch(writes, false),
      registeredProjects: [],
    }),
  ).rejects.toThrow('does not advertise day record id support')
  expect(writes).toEqual([])
})

test('a collection timestamp change on every day resends only the newest day', async () => {
  insertThreeDays()
  const writes: Record<string, unknown>[] = []
  const options = {
    baseUrl: 'https://hub.example.test',
    token: 'session',
    fetch: syncFetch(writes),
    registeredProjects: [],
  }

  await syncEvidence(options)
  writeTransaction((conn) =>
    conn.query(`UPDATE day SET collected_at = day || 'T13:00:00.000Z'`).run(),
  )
  const second = await syncEvidence(options)

  expect(second.day.changed).toBe(1)
  expect(writes).toHaveLength(2)
  expect(writes[1]).toMatchObject({
    method: 'PUT',
    recordSpace: null,
    body: {
      rows: [
        {
          id: dayId,
          day: '2026-10-08',
          claude_tokens: 42,
          collected_at: '2026-10-08T13:00:00.000Z',
        },
      ],
    },
  })
})

test('a new date does not resend the previous newest day for its timestamp alone', async () => {
  insertThreeDays()
  const writes: Record<string, unknown>[] = []
  const options = {
    baseUrl: 'https://hub.example.test',
    token: 'session',
    fetch: syncFetch(writes),
    registeredProjects: [],
  }

  await syncEvidence(options)
  writeTransaction((conn) =>
    conn.query(`UPDATE day SET collected_at = day || 'T13:00:00.000Z'`).run(),
  )
  const newestId = '44444444-4444-4444-8444-444444444444'
  insertDay(newestId, '2026-10-09')
  const second = await syncEvidence(options)

  expect(second.day.changed).toBe(1)
  expect(writes).toHaveLength(2)
  expect(writes[1]).toMatchObject({
    method: 'PUT',
    recordSpace: null,
    body: {
      rows: [{ id: newestId, day: '2026-10-09', collected_at: '2026-10-09T12:00:00.000Z' }],
    },
  })
})
