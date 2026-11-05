import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { pullHostedChanges } from './hosted-change-cache.ts'

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
    spaceChanges: true,
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
    if (url.pathname === '/v1/tasks') {
      if (space === options.failTaskSpaceOnce && !failed) {
        failed = true
        return Response.json({ error: 'offline' }, { status: 503 })
      }
      return Response.json(emptyTaskPage)
    }
    if (url.pathname === '/v1/notes') return Response.json(emptyNotePage)
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
