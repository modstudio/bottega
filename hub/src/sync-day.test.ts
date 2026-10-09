import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { writeTransaction } from './db.ts'
import { syncEvidence } from './sync.ts'

beforeEach(resetFixtureStore)

const dayId = '33333333-3333-4333-8333-333333333333'

function insertDay() {
  writeTransaction((conn) =>
    conn
      .query(
        `INSERT INTO day (record_id,day,claude_tokens,messages,collected_at)
         VALUES (?,?,?,?,?)`,
      )
      .run(dayId, '2026-10-08', 42, 2, '2026-10-08T12:00:00.000Z'),
  )
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

test('a collection timestamp change alone does not resend an acknowledged day', async () => {
  insertDay()
  const writes: Record<string, unknown>[] = []
  const options = {
    baseUrl: 'https://hub.example.test',
    token: 'session',
    fetch: syncFetch(writes),
    registeredProjects: [],
  }

  await syncEvidence(options)
  writeTransaction((conn) =>
    conn
      .query(`UPDATE day SET collected_at=? WHERE day=?`)
      .run('2026-10-08T13:00:00.000Z', '2026-10-08'),
  )
  const second = await syncEvidence(options)

  expect(second.day.changed).toBe(0)
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({
    method: 'PUT',
    recordSpace: null,
    body: {
      rows: [{ id: dayId, day: '2026-10-08', claude_tokens: 42 }],
    },
  })
})
