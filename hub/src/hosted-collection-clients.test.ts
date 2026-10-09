import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { pullHostedNotes } from './note-cache.ts'
import { pullHostedReports } from './report-cache.ts'

beforeEach(resetFixtureStore)

const html = async () =>
  new Response('<html>app</html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })

test('hosted note and report pulls refuse HTML and preserve their cursors', async () => {
  writeTransaction((conn) => {
    const put = conn.query(`INSERT INTO setting(key,value) VALUES (?,?)`)
    put.run('collect.hosted-notes.cursor', 'note-before')
    put.run('collect.hosted-sends.cursor', 'report-before')
  })
  const noteFetch = async (input: string | URL | Request) => {
    if (String(input).endsWith('/v1/tasks/identity'))
      return Response.json({
        userId: 'user-1',
        activeSpaceId: 'space-1',
        memberships: [{ spaceId: 'space-1', slug: 'workshop' }],
        capabilities: { projectNoteCounters: true },
      })
    return html()
  }
  const options = { baseUrl: 'https://hub.example.test', token: 'session', fetch: html }

  await expect(pullHostedNotes({ ...options, fetch: noteFetch })).rejects.toThrow(
    'hosted notes refused the response from https://hub.example.test/v1/notes',
  )
  await expect(pullHostedReports(options)).rejects.toThrow(
    'hosted reports refused the response from https://hub.example.test/v1/sends',
  )
  const rows = db()
    .query<{ key: string; value: string }, []>(
      `SELECT key,value FROM setting WHERE key IN
       ('collect.hosted-notes.cursor','collect.hosted-sends.cursor') ORDER BY key`,
    )
    .all()
  expect(rows).toEqual([
    { key: 'collect.hosted-notes.cursor', value: 'note-before' },
    { key: 'collect.hosted-sends.cursor', value: 'report-before' },
  ])
})

test('hosted send pull updates the existing row with the same record id', async () => {
  writeTransaction((conn) => {
    conn
      .query(`INSERT INTO send(record_id,at,window,recipients,projects,items,status,error,test)
        VALUES ('01990000-0000-7000-8000-000000000301','2026-10-08T12:00:00.000Z','day','[]','[]',1,'sent',NULL,0)`)
      .run()
  })
  const fetch = async () =>
    Response.json({
      sends: [
        {
          id: '01990000-0000-7000-8000-000000000301',
          at: '2026-10-08T13:00:00.000Z',
          window: 'day',
          recipients: '[]',
          projects: '[]',
          items: 1,
          status: 'failed',
          error: null,
          test: 0,
          created_at: '2026-10-08T12:00:00.000Z',
          machine: 'other',
        },
      ],
      cursor: '2026-10-08T12:00:00.000Z',
    })

  await pullHostedReports({ baseUrl: 'https://hub.example.test', token: 'session', fetch })

  expect(db().query<{ count: number }, []>('SELECT count(*) count FROM send').get()?.count).toBe(1)
  expect(
    db().query<{ at: string; status: string }, []>('SELECT at,status FROM send').get(),
  ).toEqual({ at: '2026-10-08T13:00:00.000Z', status: 'failed' })
})

test('note pull isolates spaces and fetches a missing note before its acknowledgement', async () => {
  const noteId = '01990000-0000-7000-8000-000000000401'
  const acknowledgementId = '01990000-0000-7000-8000-000000000402'
  const at = '2026-10-09T12:00:00.000Z'
  const note = {
    id: noteId,
    number: 1,
    project: 'workshop',
    project_name: 'workshop',
    text: 'fetched before acknowledgement',
    area: null,
    anchors: '[]',
    sightings: 1,
    created_at: at,
    last_seen_at: at,
    stale_at: null,
    stale_reason: null,
    promoted_task: null,
    updated_at: at,
    deleted_at: null,
  }
  let failGamma = true
  const requests: Array<{ space: string | null; cursor: string | null }> = []
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    if (url.pathname === '/v1/tasks/identity')
      return Response.json({
        userId: 'user-1',
        activeSpaceId: 'space-a',
        memberships: [
          { spaceId: 'space-a', slug: 'active' },
          { spaceId: 'space-gamma', slug: 'declared-gamma-space' },
        ],
        capabilities: { projectNoteCounters: true, targetSpaceNotes: true },
      })
    const space = new Headers(init?.headers).get('x-record-space')
    if (url.pathname === `/v1/notes/${noteId}`) return Response.json(note)
    requests.push({ space, cursor: url.searchParams.get('cursor') })
    if (space === 'space-gamma' && failGamma)
      return Response.json({ error: 'gamma unavailable' }, { status: 503 })
    return Response.json({
      notes: [],
      acknowledgements:
        space === 'space-a' && !url.searchParams.has('cursor')
          ? [
              {
                id: acknowledgementId,
                note_id: noteId,
                project_name: 'workshop',
                session_id: 'session-1',
                acknowledged_at: at,
                sightings: 1,
                created_at: at,
                updated_at: at,
                deleted_at: null,
              },
            ]
          : [],
      projectCounters: [],
      cursor: `${space}-after`,
    })
  }
  const options = { baseUrl: 'https://hub.example.test', token: 'session', fetch }
  await expect(pullHostedNotes(options)).rejects.toThrow('space-gamma: hosted hub refused')
  expect(db().query('SELECT 1 FROM note WHERE record_id=?').get(noteId)).toBeTruthy()
  expect(
    db().query('SELECT 1 FROM note_acknowledgement WHERE record_id=?').get(acknowledgementId),
  ).toBeTruthy()
  expect(
    db()
      .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?')
      .get('collect.hosted-notes.cursor.space-a')?.value,
  ).toBe('space-a-after')

  failGamma = false
  await pullHostedNotes(options)
  expect(requests).toEqual([
    { space: 'space-a', cursor: null },
    { space: 'space-gamma', cursor: null },
    { space: 'space-a', cursor: 'space-a-after' },
    { space: 'space-gamma', cursor: null },
  ])
  expect(
    db()
      .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?')
      .get('collect.hosted-notes.cursor.space-gamma')?.value,
  ).toBe('space-gamma-after')
})

test('note pull applies a deleted acknowledgement without fetching its absent note', async () => {
  const noteId = '01990000-0000-7000-8000-000000000411'
  const acknowledgementId = '01990000-0000-7000-8000-000000000412'
  const at = '2026-10-09T12:00:00.000Z'
  let noteFetches = 0
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    if (url.pathname === '/v1/tasks/identity')
      return Response.json({
        userId: 'user-1',
        activeSpaceId: 'space-a',
        memberships: [
          { spaceId: 'space-a', slug: 'active' },
          { spaceId: 'space-gamma', slug: 'declared-gamma-space' },
        ],
        capabilities: { projectNoteCounters: true, targetSpaceNotes: true },
      })
    if (url.pathname === `/v1/notes/${noteId}`) {
      noteFetches += 1
      return Response.json({ error: 'not found' }, { status: 404 })
    }
    const space = new Headers(init?.headers).get('x-record-space')
    return Response.json({
      notes: [],
      acknowledgements:
        space === 'space-a'
          ? [
              {
                id: acknowledgementId,
                note_id: noteId,
                project_name: 'workshop',
                session_id: 'session-1',
                acknowledged_at: at,
                sightings: 1,
                created_at: at,
                updated_at: at,
                deleted_at: at,
              },
            ]
          : [],
      projectCounters: [],
      cursor: `${space}-after-deleted`,
    })
  }

  await pullHostedNotes({ baseUrl: 'https://hub.example.test', token: 'session', fetch })

  expect(noteFetches).toBe(0)
  expect(
    db()
      .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?')
      .get('collect.hosted-notes.cursor.space-a')?.value,
  ).toBe('space-a-after-deleted')
})
