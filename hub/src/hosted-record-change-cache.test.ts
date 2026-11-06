import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { pullHostedChanges } from './hosted-change-cache.ts'
import type { HostedAcknowledgement, HostedNote } from './hosted-notes.ts'
import type { HostedSend } from './hosted-reports.ts'
import { applyHostedAcknowledgement, applyHostedNote } from './note-cache.ts'
import {
  drainHostedOutbox,
  listHostedOutbox,
  queueHostedChange,
  showHostedOutboxEntry,
} from './outbox.ts'
import { HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE, HOSTED_NOTE_TABLE } from './push-contract.ts'

beforeEach(resetFixtureStore)

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
const emptyTaskPage = {
  tasks: [],
  comments: [],
  documents: [],
  statusEvents: [],
  cursor: '',
  more: false,
}
const emptyNotePage = {
  notes: [],
  acknowledgements: [],
  projectCounters: [],
  cursor: '',
  more: false,
}
const emptySendPage = { sends: [], cursor: null, more: false }
const reset = (cursor: string) =>
  Response.json({ reset: true, cursor, tables: [] }, { status: 410 })
const page = (cursor: string, changes: unknown[] = [], more = false) =>
  Response.json({ changes, cursor, lag: 0, more })

function stored(key: string) {
  return db().query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?').get(key)
    ?.value
}

function route(options: {
  feed: (after: string | null, call: number) => Response
  failTaskSpaceOnce?: string
  calls?: Array<{ path: string; space: string | null; after: string | null }>
  identity?: typeof identity
  getTask?: (id: string) => Response
  getNote?: (id: string) => Response
  notes?: (cursor: string | null, space: string | null) => Response
}) {
  let feedCalls = 0
  let failed = false
  return async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const space = new Headers(init?.headers).get('x-record-space')
    options.calls?.push({ path: url.pathname, space, after: url.searchParams.get('after') })
    if (url.pathname === '/v1/tasks/identity') return Response.json(options.identity ?? identity)
    if (url.pathname === '/v1/changes')
      return options.feed(url.searchParams.get('after'), feedCalls++)
    if (url.pathname.startsWith('/v1/tasks/') && options.getTask)
      return options.getTask(url.pathname.split('/').at(-1)!)
    if (url.pathname === '/v1/tasks') {
      if (space === options.failTaskSpaceOnce && !failed) {
        failed = true
        return Response.json({ error: 'offline' }, { status: 503 })
      }
      return Response.json(emptyTaskPage)
    }
    if (url.pathname.startsWith('/v1/notes/') && options.getNote)
      return options.getNote(url.pathname.split('/').at(-1)!)
    if (url.pathname === '/v1/notes')
      return options.notes?.(url.searchParams.get('cursor'), space) ?? Response.json(emptyNotePage)
    if (url.pathname === '/v1/sends') return Response.json(emptySendPage)
    throw new Error(`unexpected route ${url.pathname}`)
  }
}

test('the feed refuses an identity without recordChanges before requesting changes', async () => {
  const calls: Array<{ path: string; space: string | null; after: string | null }> = []
  const fetch = route({
    feed: () => {
      throw new Error('feed must not be requested')
    },
    calls,
    identity: { ...identity, capabilities: { ...identity.capabilities, recordChanges: false } },
  })

  await expect(
    pullHostedChanges({ ...options, fetch, registeredProjects: registered }),
  ).rejects.toThrow(
    'the hosted hub does not serve the record change feed; release the hosted hub at or after the version that does',
  )
  expect(calls.map((call) => call.path)).toEqual(['/v1/tasks/identity'])
})

test('the feed snapshot cursor neither reads nor overwrites legacy snapshot state', async () => {
  const legacyKey = 'collect.hosted-changes.cursor.snapshot.space-one'
  const legacyValue = JSON.stringify({ head: 42, cursor: 'legacy-page' })
  writeTransaction((conn) =>
    conn.query('INSERT INTO setting(key,value) VALUES (?,?)').run(legacyKey, legacyValue),
  )
  const calls: Array<{ path: string; space: string | null; after: string | null }> = []
  const fetch = route({
    feed: (after) => (after === null ? reset('horizon') : page('horizon')),
    calls,
  })

  await pullHostedChanges({
    ...options,
    fetch,
    registeredProjects: registered.slice(0, 1),
  })

  expect(calls.find((call) => call.path === '/v1/tasks' && call.space === 'space-one')?.after).toBe(
    null,
  )
  expect(stored(legacyKey)).toBe(legacyValue)
  expect(stored('collect.hosted-record-changes.snapshot.task.space-one')).toBeUndefined()
})

test('a first feed pass full-pulls every family and space before storing the horizon', async () => {
  const calls: Array<{ path: string; space: string | null; after: string | null }> = []
  const fetch = route({
    feed: (after) => (after === null ? reset('horizon') : page('horizon')),
    calls,
  })
  const report = await pullHostedChanges({ ...options, fetch, registeredProjects: registered })
  expect(stored('collect.hosted-record-changes.cursor')).toBe('horizon')
  expect(JSON.parse(stored('collect.hosted-record-changes.pending')!)).toEqual([])
  expect(
    calls
      .filter((call) => call.path === '/v1/tasks')
      .map((call) => call.space)
      .sort(),
  ).toEqual(['space-one', 'space-two'])
  expect(
    calls
      .filter((call) => call.path === '/v1/notes')
      .map((call) => call.space)
      .sort(),
  ).toEqual(['space-one', 'space-two'])
  expect(calls.filter((call) => call.path === '/v1/sends').map((call) => call.space)).toEqual([
    null,
  ])
  expect(report.families.map((family) => family.report.resets)).toEqual([2, 2, 1])
})

test('one feed page splits families, skips an outside space, and advances one cursor', async () => {
  writeTransaction((conn) => {
    conn
      .query('INSERT INTO setting(key,value) VALUES (?,?)')
      .run('collect.hosted-record-changes.cursor', 'before')
    conn.query('INSERT INTO setting(key,value) VALUES (?,?)').run(
      'collect.hosted-record-changes.spaces',
      JSON.stringify({
        task: ['space-one', 'space-two'],
        note: ['space-one', 'space-two'],
        send: ['space-one'],
      }),
    )
  })
  const changes = [
    { table: 'hub_task', id: 'task-one', space: 'space-one', op: 'delete' },
    { table: 'hub_note', id: 'note-one', space: 'space-two', op: 'delete' },
    { table: 'hub_send', id: 'send-one', space: 'space-one', op: 'delete' },
    { table: 'hub_send', id: 'send-outside', space: 'space-two', op: 'delete' },
  ]
  const report = await pullHostedChanges({
    ...options,
    fetch: route({ feed: () => page('after', changes) }),
    registeredProjects: registered,
  })
  expect(stored('collect.hosted-record-changes.cursor')).toBe('after')
  expect(report.families.find((family) => family.name === 'send')?.report.spaces).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ spaceId: 'space-one', deletesSkipped: 1 }),
      expect.objectContaining({ spaceId: 'space-two', outsidePullSetSkipped: 1 }),
    ]),
  )
})

test('a move out of the pull set applies its old-space delete before skipping the new-space upsert', async () => {
  writeTransaction((conn) => {
    conn
      .query('INSERT INTO setting(key,value) VALUES (?,?)')
      .run('collect.hosted-record-changes.cursor', 'before')
    conn
      .query('INSERT INTO setting(key,value) VALUES (?,?)')
      .run(
        'collect.hosted-record-changes.spaces',
        JSON.stringify({ task: ['space-one'], note: ['space-one'], send: ['space-one'] }),
      )
    conn
      .query(
        `INSERT INTO task(record_id,key,project,source,first_seen,last_seen)
         VALUES (?,?,?,?,?,?)`,
      )
      .run('moved-task', 'DEV-1', 'one', 'local', '2026-01-01', '2026-01-01')
  })
  const changes = [
    { table: 'hub_task', id: 'moved-task', space: 'space-one', op: 'delete' },
    { table: 'hub_task', id: 'moved-task', space: 'space-two', op: 'upsert', row: {} },
  ]
  const report = await pullHostedChanges({
    ...options,
    fetch: route({ feed: () => page('after', changes) }),
    registeredProjects: registered.slice(0, 1),
  })
  expect(db().query('SELECT 1 FROM task WHERE record_id=?').get('moved-task')).toBeNull()
  expect(report.families.find((family) => family.name === 'task')?.report.spaces).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ spaceId: 'space-one', deletesApplied: 1 }),
      expect.objectContaining({ spaceId: 'space-two', outsidePullSetSkipped: 1 }),
    ]),
  )
})

test('a failed full pull remains pending while the feed advances and retries next pass', async () => {
  const calls: Array<{ path: string; space: string | null; after: string | null }> = []
  const fetch = route({
    feed: (after) => (after === null ? reset('horizon') : page('advanced')),
    failTaskSpaceOnce: 'space-two',
    calls,
  })
  await expect(
    pullHostedChanges({ ...options, fetch, registeredProjects: registered }),
  ).rejects.toThrow('task:space-two')
  expect(stored('collect.hosted-record-changes.cursor')).toBe('advanced')
  expect(JSON.parse(stored('collect.hosted-record-changes.pending')!)).toContain('task:space-two')
  await pullHostedChanges({ ...options, fetch, registeredProjects: registered })
  expect(JSON.parse(stored('collect.hosted-record-changes.pending')!)).not.toContain(
    'task:space-two',
  )
  expect(
    calls.filter((call) => call.path === '/v1/tasks' && call.space === 'space-two'),
  ).toHaveLength(2)
})

test('a newly registered space is full-pulled once and then only followed', async () => {
  writeTransaction((conn) => {
    conn
      .query('INSERT INTO setting(key,value) VALUES (?,?)')
      .run('collect.hosted-record-changes.cursor', 'before')
    conn
      .query('INSERT INTO setting(key,value) VALUES (?,?)')
      .run(
        'collect.hosted-record-changes.spaces',
        JSON.stringify({ task: ['space-one'], note: ['space-one'], send: ['space-one'] }),
      )
  })
  const calls: Array<{ path: string; space: string | null; after: string | null }> = []
  const fetch = route({ feed: () => page('after'), calls })
  await pullHostedChanges({ ...options, fetch, registeredProjects: registered })
  await pullHostedChanges({ ...options, fetch, registeredProjects: registered })
  expect(
    calls.filter((call) => call.path === '/v1/tasks' && call.space === 'space-two'),
  ).toHaveLength(1)
  expect(
    calls.filter((call) => call.path === '/v1/notes' && call.space === 'space-two'),
  ).toHaveLength(1)
})

test('a cursor compare-and-set mismatch aborts the page', async () => {
  writeTransaction((conn) => {
    conn
      .query('INSERT INTO setting(key,value) VALUES (?,?)')
      .run('collect.hosted-record-changes.cursor', 'before')
    conn.query('INSERT INTO setting(key,value) VALUES (?,?)').run(
      'collect.hosted-record-changes.spaces',
      JSON.stringify({
        task: ['space-one', 'space-two'],
        note: ['space-one', 'space-two'],
        send: ['space-one'],
      }),
    )
  })
  const fetch = route({
    feed: () => {
      writeTransaction((conn) =>
        conn
          .query('UPDATE setting SET value=? WHERE key=?')
          .run('concurrent', 'collect.hosted-record-changes.cursor'),
      )
      return page('after')
    },
  })
  await expect(
    pullHostedChanges({ ...options, fetch, registeredProjects: registered }),
  ).rejects.toThrow('another collector')
  expect(stored('collect.hosted-record-changes.cursor')).toBe('concurrent')
})

test('a 410 during follow restarts once from a fresh horizon', async () => {
  writeTransaction((conn) => {
    conn
      .query('INSERT INTO setting(key,value) VALUES (?,?)')
      .run('collect.hosted-record-changes.cursor', 'stale')
    conn.query('INSERT INTO setting(key,value) VALUES (?,?)').run(
      'collect.hosted-record-changes.spaces',
      JSON.stringify({
        task: ['space-one', 'space-two'],
        note: ['space-one', 'space-two'],
        send: ['space-one'],
      }),
    )
  })
  const fetch = route({
    feed: (after) => (after === 'stale' || after === null ? reset('fresh') : page('fresh')),
  })
  const report = await pullHostedChanges({ ...options, fetch, registeredProjects: registered })
  expect(stored('collect.hosted-record-changes.cursor')).toBe('fresh')
  expect(report.families.map((family) => family.report.resets)).toEqual([2, 2, 1])
})
const at = '2026-10-09T12:00:00.000Z'
const noteId = '01990000-0000-7000-8000-000000001250'
const otherNoteId = '01990000-0000-7000-8000-000000001251'
const acknowledgementId = '01990000-0000-7000-8000-000000001252'
const sendId = '01990000-0000-7000-8000-000000001260'

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
const familyReport = (report: Awaited<ReturnType<typeof pullHostedChanges>>, family: string) =>
  report.families.find((entry) => entry.name === family)!.report

test('the first record-feed snapshot stores project note counters', async () => {
  await pullHostedChanges({
    ...options,
    fetch: route({
      feed: (after) => (after === null ? reset('horizon') : page('horizon')),
      notes: (_cursor, space) =>
        Response.json({
          ...emptyNotePage,
          projectCounters: space === 'space-one' ? [{ project: 'one', next: 8 }] : [],
        }),
    }),
    registeredProjects: registered,
  })

  expect(
    db()
      .query<{ next: number }, [string]>('SELECT next FROM note_counter WHERE project=?')
      .get('one'),
  ).toEqual({ next: 8 })
})

test('a first record-feed pull skips an acknowledgement whose deleted parent was on an earlier snapshot page', async () => {
  let notePage = 0
  let parentFetches = 0
  await pullHostedChanges({
    ...options,
    fetch: route({
      feed: (after) => (after === null ? reset('horizon') : page('horizon')),
      notes: (_cursor, space) => {
        if (space !== 'space-one') return Response.json(emptyNotePage)
        notePage += 1
        if (notePage === 1)
          return Response.json({
            ...emptyNotePage,
            notes: [note({ deleted_at: at })],
            cursor: 'notes',
            more: true,
          })
        if (notePage === 2)
          return Response.json({
            ...emptyNotePage,
            acknowledgements: [acknowledgement()],
            cursor: 'acks',
            more: true,
          })
        return Response.json({ ...emptyNotePage, cursor: 'done', more: false })
      },
      getNote: () => {
        parentFetches += 1
        return Response.json({ error: 'note not found' }, { status: 404 })
      },
    }),
    registeredProjects: registered,
  })
  expect(notePage).toBe(3)
  expect(parentFetches).toBe(1)
  expect(db().query('SELECT 1 FROM note WHERE record_id=?').get(noteId)).toBeNull()
  expect(
    db().query('SELECT 1 FROM note_acknowledgement WHERE record_id=?').get(acknowledgementId),
  ).toBeNull()
})

test('record-feed note upserts count timestamp no-ops and deletes honor the row space', async () => {
  seedFeed()
  writeTransaction((conn) => applyHostedNote(conn, note()))
  const updated = await pullHostedChanges({
    ...options,
    fetch: route({
      feed: () =>
        page('updated', [
          { table: 'hub_note', id: noteId, space: 'space-one', op: 'upsert', row: note() },
          {
            table: 'hub_note',
            id: noteId,
            space: 'space-one',
            op: 'upsert',
            row: note({ text: 'new' }),
          },
        ]),
    }),
    registeredProjects: registered,
  })
  expect(familyReport(updated, 'note')).toMatchObject({ upsertsNoop: 1, upsertsChanged: 1 })
  const deleted = await pullHostedChanges({
    ...options,
    fetch: route({
      feed: () =>
        page('deleted', [
          { table: 'hub_note', id: noteId, space: 'space-two', op: 'delete' },
          { table: 'hub_note', id: noteId, space: 'space-one', op: 'delete' },
        ]),
    }),
    registeredProjects: registered,
  })
  expect(familyReport(deleted, 'note')).toMatchObject({ deletesApplied: 1, deletesSkipped: 1 })
  expect(db().query('SELECT 1 FROM note WHERE record_id=?').get(noteId)).toBeNull()
})

test('record-feed acknowledgement deletes use their note space and skip an absent note', async () => {
  seedFeed()
  writeTransaction((conn) => {
    applyHostedNote(conn, note())
    applyHostedAcknowledgement(conn, acknowledgement())
  })
  const skipped = await pullHostedChanges({
    ...options,
    fetch: route({
      feed: () =>
        page('skipped', [
          {
            table: 'hub_note_acknowledgement',
            id: acknowledgementId,
            space: 'space-two',
            op: 'delete',
          },
        ]),
    }),
    registeredProjects: registered,
  })
  expect(familyReport(skipped, 'note').deletesSkipped).toBe(1)
  writeTransaction((conn) => conn.query('DELETE FROM note WHERE record_id=?').run(noteId))
  const absent = await pullHostedChanges({
    ...options,
    fetch: route({
      feed: () =>
        page('absent', [
          {
            table: 'hub_note_acknowledgement',
            id: acknowledgementId,
            space: 'space-one',
            op: 'delete',
          },
        ]),
    }),
    registeredProjects: registered,
  })
  expect(familyReport(absent, 'note').deletesSkipped).toBe(1)
})

test('record-feed acknowledgements order after their note and fetch a missing parent across pages', async () => {
  seedFeed()
  const secondAck = '01990000-0000-7000-8000-000000001253'
  let fetches = 0
  const report = await pullHostedChanges({
    ...options,
    fetch: route({
      feed: (_after, call) =>
        call === 0
          ? page(
              'middle',
              [
                {
                  table: 'hub_note_acknowledgement',
                  id: acknowledgementId,
                  space: 'space-one',
                  op: 'upsert',
                  row: acknowledgement(),
                },
                { table: 'hub_note', id: noteId, space: 'space-one', op: 'upsert', row: note() },
              ],
              true,
            )
          : page('after', [
              {
                table: 'hub_note_acknowledgement',
                id: secondAck,
                space: 'space-one',
                op: 'upsert',
                row: acknowledgement({ id: secondAck, session_id: 'session-2' }),
              },
            ]),
      getNote: () => {
        fetches += 1
        return Response.json(note())
      },
    }),
    registeredProjects: registered,
  })
  expect(fetches).toBe(0)
  expect(db().query('SELECT count(*) count FROM note_acknowledgement').get()).toEqual({ count: 2 })
  expect(familyReport(report, 'note').upsertsChanged).toBe(3)

  writeTransaction((conn) => conn.query('DELETE FROM note WHERE record_id=?').run(noteId))
  await pullHostedChanges({
    ...options,
    fetch: route({
      feed: () =>
        page('fetched', [
          {
            table: 'hub_note_acknowledgement',
            id: acknowledgementId,
            space: 'space-one',
            op: 'upsert',
            row: acknowledgement({ sightings: 2 }),
          },
        ]),
      getNote: () => {
        fetches += 1
        return Response.json(note())
      },
    }),
    registeredProjects: registered,
  })
  expect(fetches).toBe(1)
  expect(db().query('SELECT 1 FROM note WHERE record_id=?').get(noteId)).not.toBeNull()
})

test('a pulled acknowledgement adopts its hosted id without stranding a queued keep', async () => {
  seedFeed()
  const localId = '01990000-0000-7000-8000-000000001254'
  writeTransaction((conn) => {
    applyHostedNote(conn, note())
    conn
      .query(`INSERT INTO note_acknowledgement
      (record_id,note_record_id,session_id,acknowledged_at,sightings) VALUES (?,?,?,?,?)`)
      .run(localId, noteId, 'session-1', '2026-10-09T13:00:00.000Z', 2)
    queueHostedChange(conn, HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE, localId, 'upsert', at)
  })
  await pullHostedChanges({
    ...options,
    fetch: route({
      feed: () =>
        page('after', [
          {
            table: HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE,
            id: acknowledgementId,
            space: 'space-one',
            op: 'upsert',
            row: acknowledgement(),
          },
        ]),
    }),
    registeredProjects: registered,
  })
  expect(
    db().query('SELECT record_id,acknowledged_at,sightings FROM note_acknowledgement').get(),
  ).toEqual({
    record_id: acknowledgementId,
    acknowledged_at: '2026-10-09T13:00:00.000Z',
    sightings: 2,
  })
  expect(db().query('SELECT row_id,generation FROM hosted_outbox').get()).toEqual({
    row_id: acknowledgementId,
    generation: 2,
  })
})

test('record-feed note reconciliation merges pending sightings and quarantines a hosted deletion', async () => {
  seedFeed()
  const localAnchor = '01990000-0000-7000-8000-000000001255'
  const hostedAnchor = '01990000-0000-7000-8000-000000001256'
  writeTransaction((conn) => {
    applyHostedNote(
      conn,
      note({
        anchors: JSON.stringify([{ kind: 'run' }, { id: localAnchor, kind: 'run' }]),
        sightings: 2,
      }),
    )
    queueHostedChange(conn, HOSTED_NOTE_TABLE, noteId, 'upsert', at, ['anchors', 'last_seen_at'])
  })
  await pullHostedChanges({
    ...options,
    fetch: route({
      feed: () =>
        page('merged', [
          {
            table: HOSTED_NOTE_TABLE,
            id: noteId,
            space: 'space-one',
            op: 'upsert',
            row: note({
              anchors: JSON.stringify([{ kind: 'run' }, { id: hostedAnchor, kind: 'run' }]),
              sightings: 2,
            }),
          },
        ]),
    }),
    registeredProjects: registered,
  })
  const merged = db()
    .query<{ anchors: string; sightings: number }, [string]>(
      'SELECT anchors,sightings FROM note WHERE record_id=?',
    )
    .get(noteId)!
  expect(merged.sightings).toBe(3)
  expect(JSON.parse(merged.anchors)).toEqual([
    { kind: 'run' },
    { id: hostedAnchor, kind: 'run' },
    { id: localAnchor, kind: 'run' },
  ])
  const sent: Array<{ row?: { anchors?: string } }> = []
  expect(
    (
      await drainHostedOutbox({
        identity: async () => ({
          userId: 'user-one',
          activeSpaceId: 'space-one',
          memberships: [{ spaceId: 'space-one', slug: 'one', permission: 'write' as const }],
          capabilities: { spacePush: true, spacePushTables: [HOSTED_NOTE_TABLE] },
        }),
        registered: () => [{ name: 'one', settings: { space: 'space-one' } }],
        push: async (changes) => {
          sent.push(...(changes as Array<{ row?: { anchors?: string } }>))
          return changes.map((change) => ({ id: change.id, status: 'applied' as const }))
        },
      })
    ).sent,
  ).toBe(1)
  expect(JSON.parse(sent[0]!.row!.anchors!)).toContainEqual({ id: localAnchor, kind: 'run' })

  resetFixtureStore()
  seedFeed()
  writeTransaction((conn) => {
    applyHostedNote(conn, note({ anchors: JSON.stringify([{ id: localAnchor, kind: 'run' }]) }))
    queueHostedChange(conn, HOSTED_NOTE_TABLE, noteId, 'upsert', at, ['anchors', 'last_seen_at'])
  })
  await pullHostedChanges({
    ...options,
    fetch: route({
      feed: () =>
        page('deleted', [
          {
            table: HOSTED_NOTE_TABLE,
            id: noteId,
            space: 'space-one',
            op: 'upsert',
            row: note({ deleted_at: at }),
          },
        ]),
    }),
    registeredProjects: registered,
  })
  const entry = listHostedOutbox()[0]!
  expect(entry.quarantined_at).not.toBeNull()
  expect(showHostedOutboxEntry(entry.id).join('\n')).toContain(localAnchor)
  expect(db().query('SELECT 1 FROM note WHERE record_id=?').get(noteId)).toBeNull()
})

test('a deleted note skips its live acknowledgement without a parent fetch', async () => {
  seedFeed()
  let parentFetches = 0
  const report = await pullHostedChanges({
    ...options,
    fetch: route({
      feed: () =>
        page('after', [
          {
            table: 'hub_note',
            id: noteId,
            space: 'space-one',
            op: 'upsert',
            row: note({ deleted_at: at }),
          },
          {
            table: 'hub_note_acknowledgement',
            id: acknowledgementId,
            space: 'space-one',
            op: 'upsert',
            row: acknowledgement(),
          },
        ]),
      getNote: () => {
        parentFetches += 1
        return Response.json(note({ deleted_at: at }))
      },
    }),
    registeredProjects: registered,
  })
  expect(parentFetches).toBe(0)
  expect(familyReport(report, 'note')).toMatchObject({ upsertsNoop: 1, deletesSkipped: 1 })
  expect(db().query('SELECT 1 FROM note').get()).toBeNull()
  expect(db().query('SELECT 1 FROM note_acknowledgement').get()).toBeNull()
})

test('a failed note parent fetch leaves the page and record cursor untouched', async () => {
  seedFeed()
  await expect(
    pullHostedChanges({
      ...options,
      fetch: route({
        feed: () =>
          page('after', [
            {
              table: 'hub_note_acknowledgement',
              id: acknowledgementId,
              space: 'space-one',
              op: 'upsert',
              row: acknowledgement(),
            },
          ]),
        getNote: () => Response.json({ error: 'parent unavailable' }, { status: 503 }),
      }),
      registeredProjects: registered,
    }),
  ).rejects.toThrow('parent unavailable')
  expect(stored('collect.hosted-record-changes.cursor')).toBe('before')
  expect(db().query('SELECT 1 FROM note').get()).toBeNull()
  expect(db().query('SELECT 1 FROM note_acknowledgement').get()).toBeNull()
})

test('a note collision refuses the record page and rolls back earlier family writes', async () => {
  seedFeed()
  writeTransaction((conn) => applyHostedNote(conn, note({ id: otherNoteId })))
  await expect(
    pullHostedChanges({
      ...options,
      fetch: route({
        feed: () =>
          page('after', [
            { table: 'hub_send', id: sendId, space: 'space-one', op: 'upsert', row: hostedSend() },
            {
              table: 'hub_note',
              id: otherNoteId,
              space: 'space-one',
              op: 'upsert',
              row: note({ id: otherNoteId, text: 'would roll back' }),
            },
            { table: 'hub_note', id: noteId, space: 'space-one', op: 'upsert', row: note() },
          ]),
      }),
      registeredProjects: registered,
    }),
  ).rejects.toThrow('belongs to UUID')
  expect(stored('collect.hosted-record-changes.cursor')).toBe('before')
  expect(db().query('SELECT text FROM note WHERE record_id=?').get(otherNoteId)).toEqual({
    text: 'remember this',
  })
  expect(db().query('SELECT 1 FROM send').get()).toBeNull()
})

test('a later family failure preserves a family result committed by an earlier record-feed page', async () => {
  seedFeed()
  await expect(
    pullHostedChanges({
      ...options,
      fetch: route({
        feed: (_after, call) =>
          call === 0
            ? page(
                'middle',
                [
                  {
                    table: 'hub_send',
                    id: sendId,
                    space: 'space-one',
                    op: 'upsert',
                    row: hostedSend(),
                  },
                ],
                true,
              )
            : page('after', [
                {
                  table: 'hub_note_acknowledgement',
                  id: acknowledgementId,
                  space: 'space-one',
                  op: 'upsert',
                  row: acknowledgement(),
                },
              ]),
        getNote: () => Response.json({ error: 'parent unavailable' }, { status: 503 }),
      }),
      registeredProjects: registered,
    }),
  ).rejects.toThrow('parent unavailable')
  expect(stored('collect.hosted-record-changes.cursor')).toBe('middle')
  expect(db().query('SELECT record_id FROM send').get()).toEqual({ record_id: sendId })
})
