import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { formatCollectLeg, hostedCollectLegs } from './collect.ts'
import { db, writeTransaction } from './db.ts'
import {
  classifyHostedChangeDelete,
  classifyHostedChangeUpsert,
  HOSTED_NOTE_CHANGES_CURSOR_KEY,
  pullHostedNoteChanges,
} from './hosted-change-cache.ts'
import type { HostedAcknowledgement, HostedNote } from './hosted-notes.ts'
import {
  applyHostedAcknowledgement,
  applyHostedNote,
  applyHostedNoteRows,
  hostedNotePullRows,
} from './note-cache.ts'
import type { HostedSpaceChangePage } from './task-client.ts'

beforeEach(resetFixtureStore)

const at = '2026-10-09T12:00:00.000Z'
const noteId = '01990000-0000-7000-8000-000000001250'
const otherNoteId = '01990000-0000-7000-8000-000000001251'
const acknowledgementId = '01990000-0000-7000-8000-000000001252'
const secondAcknowledgementId = '01990000-0000-7000-8000-000000001253'
const options = { baseUrl: 'https://hub.example.test', token: 'session' } as const
const registered = [
  { name: 'one', settings: { space: 'one' } },
  { name: 'two', settings: { space: 'two' } },
]

const note = (overrides: Partial<HostedNote> = {}): HostedNote => ({
  id: noteId,
  number: 4,
  project: 'one',
  project_name: 'one',
  text: 'remember this',
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
  ...overrides,
})
const acknowledgement = (
  overrides: Partial<HostedAcknowledgement> = {},
): HostedAcknowledgement => ({
  id: acknowledgementId,
  note_id: noteId,
  project_name: 'one',
  session_id: 'session-1',
  acknowledged_at: at,
  sightings: 1,
  created_at: at,
  updated_at: at,
  deleted_at: null,
  ...overrides,
})
const page = (
  overrides: Partial<HostedSpaceChangePage> & Pick<HostedSpaceChangePage, 'next'>,
): HostedSpaceChangePage => ({
  head: 30,
  oldest: 1,
  more: false,
  resetRequired: false,
  changes: [],
  ...overrides,
})
const fullNotes = (notes: HostedNote[] = [], acknowledgements: HostedAcknowledgement[] = []) => ({
  notes,
  acknowledgements,
  projectCounters: [{ project: 'one', next: 8 }],
  cursor: at,
})
const identity = {
  userId: 'user-1',
  activeSpaceId: 'space-one',
  memberships: [
    { spaceId: 'space-one', slug: 'one' },
    { spaceId: 'space-two', slug: 'two' },
  ],
  capabilities: {
    spaceChanges: true,
    projectNoteCounters: true,
    targetSpaceNotes: true,
  },
}

type RouteOptions = {
  changes?: (space: string | null, after: string | null) => unknown | Response
  notes?: (space: string | null) => unknown | Response
  getNote?: (space: string | null, id: string) => unknown | Response
}
type TestFetch = (input: string, init?: RequestInit) => Promise<Response>
function routeFetch(options: RouteOptions) {
  return async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const space = new Headers(init?.headers).get('x-record-space')
    if (url.pathname === '/v1/tasks/identity') return Response.json(identity)
    if (url.pathname === '/v1/changes') {
      const body =
        options.changes?.(space, url.searchParams.get('after')) ??
        page({ next: Number(url.searchParams.get('after') ?? 0) })
      return body instanceof Response ? body : Response.json(body)
    }
    if (url.pathname === '/v1/notes') {
      const body = options.notes?.(space) ?? fullNotes()
      return body instanceof Response ? body : Response.json(body)
    }
    const id = url.pathname.split('/').at(-1) ?? ''
    const body = options.getNote?.(space, id) ?? note({ id })
    return body instanceof Response ? body : Response.json(body)
  }
}
const cursor = (space = 'space-one') =>
  db()
    .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?')
    .get(`${HOSTED_NOTE_CHANGES_CURSOR_KEY}.${space}`)?.value ?? null
function storeCursor(value: string, space = 'space-one') {
  writeTransaction((conn) => {
    conn
      .query(
        'INSERT INTO setting(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(`${HOSTED_NOTE_CHANGES_CURSOR_KEY}.${space}`, value)
  })
}
const pull = (fetch: TestFetch, registeredProjects = registered.slice(0, 1)) =>
  pullHostedNoteChanges({ ...options, fetch, registeredProjects })

test('change classifications depend only on the gathered row values', () => {
  expect(classifyHostedChangeDelete('space-one', 'space-one')).toBe('apply')
  expect(classifyHostedChangeDelete(null, 'space-one')).toBe('skip')
  expect(classifyHostedChangeDelete('space-two', 'space-one')).toBe('skip')
  expect(classifyHostedChangeUpsert({ text: 'same' }, { text: 'same' })).toBe('no-op')
  expect(classifyHostedChangeUpsert({ text: 'before' }, { text: 'after' })).toBe('changed')
})

test('the note family starts and resets through the full note pull including counters', async () => {
  let fullPulls = 0
  const fetch = routeFetch({
    changes: (_space, after) =>
      after === '5'
        ? page({ head: 22, next: 5, resetRequired: true })
        : page({ head: 12, next: Number(after ?? 0) }),
    notes: () => {
      fullPulls += 1
      return fullNotes([note({ text: `snapshot-${fullPulls}` })])
    },
  })
  await pull(fetch)
  expect(cursor()).toBe('12')
  expect(
    db()
      .query<{ next: number }, [string]>('SELECT next FROM note_counter WHERE project=?')
      .get('one')?.next,
  ).toBe(8)
  storeCursor('5')
  await pull(fetch)
  expect(cursor()).toBe('22')
  expect(
    db().query<{ text: string }, [string]>('SELECT text FROM note WHERE record_id=?').get(noteId)
      ?.text,
  ).toBe('snapshot-2')
})

test('note upserts distinguish a timestamp no-op from a changed row', async () => {
  storeCursor('12')
  writeTransaction((conn) => applyHostedNote(conn, note()))
  const fetch = routeFetch({
    changes: () =>
      page({
        next: 14,
        changes: [
          { sequence: 13, table: 'hub_note', id: noteId, op: 'upsert', row: note() },
          {
            sequence: 14,
            table: 'hub_note',
            id: otherNoteId,
            op: 'upsert',
            row: note({ id: otherNoteId, number: 5, text: 'new' }),
          },
        ],
      }),
  })
  const report = await pull(fetch)
  expect(report?.upsertsNoop).toBe(1)
  expect(report?.upsertsChanged).toBe(1)
})

test('note deletes apply only in the row own space', async () => {
  storeCursor('12')
  storeCursor('12', 'space-two')
  writeTransaction((conn) => applyHostedNote(conn, note()))
  const skipped = await pull(
    routeFetch({
      changes: (space) =>
        space === 'space-two'
          ? page({
              next: 13,
              changes: [{ sequence: 13, table: 'hub_note', id: noteId, op: 'delete' }],
            })
          : page({ next: 12 }),
    }),
    registered,
  )
  expect(skipped?.spaces.find((row) => row.spaceId === 'space-two')?.deletesSkipped).toBe(1)
  expect(db().query('SELECT 1 FROM note WHERE record_id=?').get(noteId)).not.toBeNull()
  const applied = await pull(
    routeFetch({
      changes: (space) =>
        space === 'space-one'
          ? page({
              next: 14,
              changes: [{ sequence: 14, table: 'hub_note', id: noteId, op: 'delete' }],
            })
          : page({ next: 13 }),
    }),
    registered,
  )
  expect(applied?.spaces.find((row) => row.spaceId === 'space-one')?.deletesApplied).toBe(1)
  expect(db().query('SELECT 1 FROM note WHERE record_id=?').get(noteId)).toBeNull()
})

test('acknowledgement deletes use their note space and skip an absent note', async () => {
  storeCursor('12')
  storeCursor('12', 'space-two')
  writeTransaction((conn) => {
    applyHostedNote(conn, note())
    applyHostedAcknowledgement(conn, acknowledgement())
  })
  const skipped = await pull(
    routeFetch({
      changes: (space) =>
        space === 'space-two'
          ? page({
              next: 13,
              changes: [
                {
                  sequence: 13,
                  table: 'hub_note_acknowledgement',
                  id: acknowledgementId,
                  op: 'delete',
                },
              ],
            })
          : page({ next: 12 }),
    }),
    registered,
  )
  expect(skipped?.spaces.find((row) => row.spaceId === 'space-two')?.deletesSkipped).toBe(1)
  expect(
    db().query('SELECT 1 FROM note_acknowledgement WHERE record_id=?').get(acknowledgementId),
  ).not.toBeNull()
  writeTransaction((conn) => conn.query('DELETE FROM note WHERE record_id=?').run(noteId))
  const absent = await pull(
    routeFetch({
      changes: (space) =>
        space === 'space-one'
          ? page({
              next: 14,
              changes: [
                {
                  sequence: 14,
                  table: 'hub_note_acknowledgement',
                  id: acknowledgementId,
                  op: 'delete',
                },
              ],
            })
          : page({ next: 13 }),
    }),
    registered,
  )
  expect(absent?.spaces.find((row) => row.spaceId === 'space-one')?.deletesSkipped).toBe(1)
})

test('acknowledgements apply after their note within a page and fetch a missing note across pages', async () => {
  storeCursor('12')
  let pass = 0
  const fetch = routeFetch({
    changes: () => {
      pass += 1
      return pass === 1
        ? page({
            next: 15,
            changes: [
              {
                sequence: 13,
                table: 'hub_note_acknowledgement',
                id: acknowledgementId,
                op: 'upsert',
                row: acknowledgement(),
              },
              { sequence: 14, table: 'hub_note', id: noteId, op: 'upsert', row: note() },
              {
                sequence: 15,
                table: 'hub_note_acknowledgement',
                id: secondAcknowledgementId,
                op: 'upsert',
                row: acknowledgement({
                  id: secondAcknowledgementId,
                  session_id: 'session-2',
                }),
              },
            ],
          })
        : page({
            next: 16,
            changes: [
              {
                sequence: 16,
                table: 'hub_note_acknowledgement',
                id: acknowledgementId,
                op: 'upsert',
                row: acknowledgement({ sightings: 2 }),
              },
            ],
          })
    },
  })
  await pull(fetch)
  expect(
    db().query('SELECT 1 FROM note_acknowledgement WHERE record_id=?').get(acknowledgementId),
  ).not.toBeNull()
  expect(
    db().query('SELECT 1 FROM note_acknowledgement WHERE record_id=?').get(secondAcknowledgementId),
  ).not.toBeNull()
  writeTransaction((conn) => conn.query('DELETE FROM note WHERE record_id=?').run(noteId))
  await pull(fetch)
  expect(
    db()
      .query<{ sightings: number }, [string]>(
        'SELECT sightings FROM note_acknowledgement WHERE record_id=?',
      )
      .get(acknowledgementId)?.sightings,
  ).toBe(2)
  expect(db().query('SELECT 1 FROM note WHERE record_id=?').get(noteId)).not.toBeNull()
})

test('an acknowledgement on a later page uses the note from an earlier page', async () => {
  storeCursor('12')
  let pageNumber = 0
  const fetch = routeFetch({
    changes: () => {
      pageNumber += 1
      return pageNumber === 1
        ? page({
            next: 13,
            more: true,
            changes: [{ sequence: 13, table: 'hub_note', id: noteId, op: 'upsert', row: note() }],
          })
        : page({
            next: 14,
            changes: [
              {
                sequence: 14,
                table: 'hub_note_acknowledgement',
                id: acknowledgementId,
                op: 'upsert',
                row: acknowledgement(),
              },
            ],
          })
    },
    getNote: () => Response.json({ error: 'must not fetch' }, { status: 500 }),
  })
  await pull(fetch)
  expect(cursor()).toBe('14')
  expect(
    db().query('SELECT 1 FROM note_acknowledgement WHERE record_id=?').get(acknowledgementId),
  ).not.toBeNull()
})

test('a failed missing-parent fetch leaves the note page and cursor untouched', async () => {
  storeCursor('12')
  const fetch = routeFetch({
    changes: () =>
      page({
        next: 13,
        changes: [
          {
            sequence: 13,
            table: 'hub_note_acknowledgement',
            id: acknowledgementId,
            op: 'upsert',
            row: acknowledgement(),
          },
        ],
      }),
    getNote: () => Response.json({ error: 'parent unavailable' }, { status: 503 }),
  })
  await expect(pull(fetch)).rejects.toThrow('parent unavailable')
  expect(cursor()).toBe('12')
  expect(db().query('SELECT 1 FROM note WHERE record_id=?').get(noteId)).toBeNull()
  expect(
    db().query('SELECT 1 FROM note_acknowledgement WHERE record_id=?').get(acknowledgementId),
  ).toBeNull()
})

test('a deleted note upsert skips its live acknowledgement without fetching in both pulls', async () => {
  const deletedNote = note({ deleted_at: at })
  let timestampParentFetches = 0
  const fetch = routeFetch({
    notes: () => fullNotes([deletedNote], [acknowledgement()]),
    getNote: () => {
      timestampParentFetches += 1
      return deletedNote
    },
  })
  const timestampRows = await hostedNotePullRows(null, { ...options, fetch })
  writeTransaction((conn) => applyHostedNoteRows(conn, timestampRows))
  const timestampState = {
    note: db().query('SELECT 1 FROM note WHERE record_id=?').get(noteId) ?? null,
    acknowledgement:
      db().query('SELECT 1 FROM note_acknowledgement WHERE record_id=?').get(acknowledgementId) ??
      null,
  }
  expect(timestampParentFetches).toBe(0)

  resetFixtureStore()
  storeCursor('12')
  let followerParentFetches = 0
  const report = await pull(
    routeFetch({
      changes: () =>
        page({
          next: 14,
          changes: [
            {
              sequence: 13,
              table: 'hub_note',
              id: noteId,
              op: 'upsert',
              row: deletedNote,
            },
            {
              sequence: 14,
              table: 'hub_note_acknowledgement',
              id: acknowledgementId,
              op: 'upsert',
              row: acknowledgement(),
            },
          ],
        }),
      getNote: () => {
        followerParentFetches += 1
        return deletedNote
      },
    }),
  )
  expect(followerParentFetches).toBe(0)
  expect(cursor()).toBe('14')
  expect(report).toMatchObject({ upsertsChanged: 0, upsertsNoop: 2 })
  expect({
    note: db().query('SELECT 1 FROM note WHERE record_id=?').get(noteId) ?? null,
    acknowledgement:
      db().query('SELECT 1 FROM note_acknowledgement WHERE record_id=?').get(acknowledgementId) ??
      null,
  }).toEqual(timestampState)
  expect(timestampState).toEqual({ note: null, acknowledgement: null })
})

test('a note collision refuses the page and leaves its cursor in place', async () => {
  storeCursor('12')
  writeTransaction((conn) => applyHostedNote(conn, note({ id: otherNoteId })))
  const fetch = routeFetch({
    changes: () =>
      page({
        next: 13,
        changes: [{ sequence: 13, table: 'hub_note', id: noteId, op: 'upsert', row: note() }],
      }),
  })
  await expect(pull(fetch)).rejects.toThrow('belongs to UUID')
  expect(cursor()).toBe('12')
})

test('one change family failing leaves the other family result intact', async () => {
  const results = await hostedCollectLegs(undefined, {
    evidence: async () => ({
      interval: { changed: 0, deleted: 0, deleteSkipped: false, local: 0, issues: [] },
      day: { changed: 0, deleted: 0, deleteSkipped: false, local: 0 },
    }),
    tasks: async () => {},
    changes: async () => {
      throw new Error('task log unavailable')
    },
    notes: async () => {},
    noteChanges: async () => ({
      upsertsChanged: 1,
      upsertsNoop: 0,
      deletesApplied: 0,
      deletesSkipped: 0,
      spaces: [
        {
          spaceId: 'space-one',
          upsertsChanged: 1,
          upsertsNoop: 0,
          deletesApplied: 0,
          deletesSkipped: 0,
        },
      ],
    }),
    reports: async () => {},
  })
  expect(results.find((result) => result.source === 'hosted task changes')?.ok).toBeFalse()
  expect(results.find((result) => result.source === 'hosted note changes')).toMatchObject({
    ok: true,
  })
  const noteResult = results.find((result) => result.source === 'hosted note changes')
  if (!noteResult) throw new Error('missing hosted note changes result')
  expect(formatCollectLeg(noteResult)).toBe(
    'hosted note changes space-one 1 changed, 0 no-op, 0 deleted, 0 skipped',
  )
})
