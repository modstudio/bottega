import { beforeEach, expect, spyOn, test } from 'bun:test'
import { RECORD_IDENTITY_MEMO_MAX_AGE_MS } from '../../shared/config-read-memo.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { writeTransaction } from './db.ts'
import { getNote, listNotes } from './note-read.ts'

beforeEach(resetFixtureStore)

const identity = {
  userId: 'user-1',
  activeSpaceId: 'space-1',
  memberships: [{ spaceId: 'space-1', slug: 'workshop', permission: 'write' }],
  capabilities: { projectNoteCounters: true, targetSpaceNotes: true },
}

test('a hosted get does not fall back to a local-only note', async () => {
  const id = crypto.randomUUID()
  const at = '2026-11-21T10:00:00.000Z'
  writeTransaction((conn) =>
    conn
      .query(
        `INSERT INTO note(record_id,number,project,text,anchors,sightings,created_at,last_seen_at)
         VALUES (?,1,'workshop','local only','[]',1,?,?)`,
      )
      .run(id, at, at),
  )
  await expect(
    getNote(id, {
      baseUrl: 'https://hub.example.test',
      token: 'test',
      fetch: async (input) =>
        new URL(input).pathname === '/v1/tasks/identity'
          ? Response.json(identity)
          : Response.json({ error: 'note not found' }, { status: 404 }),
    }),
  ).rejects.toThrow(`no note ${id}`)
})

test('hosted list delegates server filters, applies client filters, sorts, and resolves identity once', async () => {
  const requested: string[] = []
  let identities = 0
  const note = (id: string, session: string, seen: string, text = 'needle') => ({
    id,
    number: Number(id.at(-1)),
    project: 'workshop',
    project_name: 'workshop',
    text,
    area: null,
    anchors: JSON.stringify([{ session_id: session }]),
    sightings: 1,
    created_at: '2026-11-21T09:00:00.000Z',
    last_seen_at: seen,
    stale_at: null,
    stale_reason: null,
    promoted_task: null,
    updated_at: seen,
    deleted_at: null,
  })
  const keptId = '01990000-0000-7000-8000-000000002521'
  const olderId = '01990000-0000-7000-8000-000000002522'
  const newerId = '01990000-0000-7000-8000-000000002523'
  const fetch = async (input: string) => {
    const url = new URL(input)
    if (url.pathname === '/v1/tasks/identity') {
      identities++
      return Response.json(identity)
    }
    requested.push(url.search)
    if (!url.searchParams.has('cursor'))
      return Response.json({
        notes: [
          note(keptId, 'session-a', '2026-11-21T12:00:00.000Z'),
          note(olderId, 'session-a', '2026-11-21T10:00:00.000Z'),
        ],
        acknowledgements: [
          {
            id: crypto.randomUUID(),
            note_id: keptId,
            project_name: 'workshop',
            session_id: 'session-a',
            acknowledged_at: '2026-11-21T12:01:00.000Z',
            sightings: 1,
            created_at: '2026-11-21T12:01:00.000Z',
            updated_at: '2026-11-21T12:01:00.000Z',
            deleted_at: null,
          },
        ],
        cursor: 'next',
        more: true,
      })
    return Response.json({
      notes: [
        note(newerId, 'session-a', '2026-11-21T11:00:00.000Z'),
        note(crypto.randomUUID(), 'other-session', '2026-11-21T13:00:00.000Z'),
        note(crypto.randomUUID(), 'session-a', '2026-11-21T14:00:00.000Z', 'other text'),
      ],
      acknowledgements: [],
      cursor: 'done',
      more: false,
    })
  }
  const rows = await listNotes(
    {
      project: 'workshop',
      stale: false,
      actionable: true,
      session: 'session-a',
      kept: false,
      text: 'needle',
    },
    { baseUrl: 'https://hub.example.test', token: 'test', fetch },
  )
  expect(rows.map((row) => row.record_id)).toEqual([newerId, olderId])
  expect(requested).toHaveLength(2)
  for (const query of requested) {
    const params = new URLSearchParams(query)
    expect(params.get('project')).toBe('workshop')
    expect(params.get('stale')).toBe('false')
    expect(params.get('actionable')).toBe('true')
  }
  expect(identities).toBe(1)
})

test('hosted note identity is reloaded after the record identity memo max age', async () => {
  let now = 1_000
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  let identities = 0
  const fetch = async (input: string) => {
    if (new URL(input).pathname === '/v1/tasks/identity') {
      identities++
      return Response.json(identity)
    }
    return Response.json({ notes: [], acknowledgements: [], cursor: '', more: false })
  }
  const options = { baseUrl: 'https://hub.example.test', token: 'test', fetch }

  try {
    await listNotes({ project: 'workshop' }, options)
    now += RECORD_IDENTITY_MEMO_MAX_AGE_MS - 1
    await listNotes({ project: 'workshop' }, options)
    expect(identities).toBe(1)

    now++
    await listNotes({ project: 'workshop' }, options)
    expect(identities).toBe(2)
  } finally {
    clock.mockRestore()
  }
})
