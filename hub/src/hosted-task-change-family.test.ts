import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { pullHostedChanges } from './hosted-change-cache.ts'
import type { HostedTask } from './hosted-tasks.ts'
import { queueHostedChange } from './outbox.ts'
import { applyHostedTask } from './task-cache.ts'

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

const at = '2026-10-09T12:00:00.000Z'
const taskId = '01990000-0000-7000-8000-000000001240'
const commentId = '01990000-0000-7000-8000-000000001241'
const documentId = '01990000-0000-7000-8000-000000001242'
const eventId = '01990000-0000-7000-8000-000000001243'

const hostedTask = (overrides: Partial<HostedTask> = {}): HostedTask => ({
  id: taskId,
  key: 'DEV-1240',
  project: 'one',
  project_name: 'one',
  title: 'log task',
  status: 'open',
  status_category: 'open',
  parent_key: null,
  body: null,
  assignee: null,
  opened_at: at,
  closed_at: null,
  source: 'local',
  first_seen: at,
  last_seen: at,
  created_at: at,
  updated_at: at,
  deleted_at: null,
  next_document_number: 1,
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

test('the record feed applies task upserts without losing pending machine fields', async () => {
  seedFeed()
  writeTransaction((conn) => {
    applyHostedTask(conn, hostedTask({ title: 'pending machine title' }))
    conn
      .query(
        `INSERT INTO task_document
          (record_id,task_key,task_record_id,number,role,title,body,version,created_at,updated_at)
         VALUES (?,'DEV-1240',?,1,'handoff','handoff','body','v1',?,?)`,
      )
      .run(documentId, taskId, at, at)
    queueHostedChange(conn, 'hub_task', taskId, 'upsert', at, ['title'])
    queueHostedChange(conn, 'hub_task_document', documentId, 'delete', at)
    conn.query('DELETE FROM task_document WHERE record_id=?').run(documentId)
  })
  const unlinkedId = '01990000-0000-7000-8000-000000001249'
  const changes = [
    {
      table: 'hub_task',
      id: taskId,
      space: 'space-one',
      op: 'upsert',
      row: hostedTask({ title: 'hosted title', status: 'active', status_category: 'active' }),
    },
    {
      table: 'hub_task_document',
      id: documentId,
      space: 'space-one',
      op: 'upsert',
      row: {
        id: documentId,
        task_key: 'DEV-1240',
        task_id: taskId,
        project_name: 'one',
        number: 1,
        role: 'handoff',
        title: 'hosted document',
        body: 'hosted body',
        version: 'hosted-v1',
        created_at: at,
        updated_at: at,
        deleted_at: null,
      },
    },
    {
      table: 'hub_task',
      id: unlinkedId,
      space: 'space-one',
      op: 'upsert',
      row: hostedTask({ id: unlinkedId, key: 'DEV-1249', parent_key: 'DEV-1239', parent_id: null }),
    },
  ]
  await pullHostedChanges({
    ...options,
    fetch: route({ feed: () => page('after', changes) }),
    registeredProjects: registered,
  })
  expect(db().query('SELECT title,status FROM task WHERE record_id=?').get(taskId)).toEqual({
    title: 'pending machine title',
    status: 'active',
  })
  expect(db().query('SELECT 1 FROM task_document WHERE record_id=?').get(documentId)).toBeNull()
  expect(db().query('SELECT parent_record_id FROM task WHERE record_id=?').get(unlinkedId)).toEqual(
    { parent_record_id: null },
  )
})

test('the record feed applies and skips task deletes by row space, including children', async () => {
  seedFeed()
  writeTransaction((conn) => {
    applyHostedTask(conn, hostedTask())
    conn
      .query(
        `INSERT INTO task_comment (record_id,task_key,task_record_id,body,created_at)
         VALUES (?,'DEV-1240',?,'note',?)`,
      )
      .run(commentId, taskId, at)
    conn
      .query(
        `INSERT INTO task_document
          (record_id,task_key,task_record_id,number,role,title,body,version,created_at,updated_at)
         VALUES (?,'DEV-1240',?,1,'handoff','handoff','body','v1',?,?)`,
      )
      .run(documentId, taskId, at, at)
    conn
      .query(
        `INSERT INTO task_status_event (record_id,task_key,task_record_id,at,from_status,to_status)
         VALUES (?,'DEV-1240',?,?,NULL,'open')`,
      )
      .run(eventId, taskId, at)
  })
  const report = await pullHostedChanges({
    ...options,
    fetch: route({
      feed: () =>
        page('after', [
          { table: 'hub_task', id: taskId, space: 'space-two', op: 'delete' },
          { table: 'hub_task', id: taskId, space: 'space-one', op: 'delete' },
        ]),
    }),
    registeredProjects: registered,
  })
  expect(db().query('SELECT 1 FROM task WHERE record_id=?').get(taskId)).toBeNull()
  expect(db().query('SELECT 1 FROM task_comment WHERE record_id=?').get(commentId)).toBeNull()
  expect(db().query('SELECT 1 FROM task_document WHERE record_id=?').get(documentId)).toBeNull()
  expect(db().query('SELECT 1 FROM task_status_event WHERE record_id=?').get(eventId)).toBeNull()
  expect(familyReport(report, 'task')).toMatchObject({ deletesApplied: 1, deletesSkipped: 1 })
})

test('a record-feed task tombstone gives task-only intervals the task project before deletion', async () => {
  seedFeed()
  const projectId = '01990000-0000-7000-8000-000000001101'
  writeTransaction((conn) => {
    applyHostedTask(conn, hostedTask({ projectId }))
    conn
      .query(
        `INSERT INTO interval
         (record_id,task_key,task_record_id,source,start_at,end_at,ref)
         VALUES ('task-only-interval','DEV-1240',?,'orch',?,?,'task-only-interval')`,
      )
      .run(taskId, at, at)
  })
  await pullHostedChanges({
    ...options,
    fetch: route({
      feed: () =>
        page('after', [
          {
            table: 'hub_task',
            id: taskId,
            space: 'space-one',
            op: 'upsert',
            row: hostedTask({ projectId, deleted_at: at }),
          },
        ]),
    }),
    registeredProjects: registered,
  })
  expect(db().query('SELECT 1 FROM task WHERE record_id=?').get(taskId)).toBeNull()
  expect(db().query('SELECT task_record_id,project,project_record_id FROM interval').get()).toEqual(
    {
      task_record_id: null,
      project: 'one',
      project_record_id: projectId,
    },
  )
})

for (const order of ['delete-upsert', 'upsert-delete'] as const) {
  test(`a task move represented as ${order} leaves the row in its new space`, async () => {
    seedFeed()
    writeTransaction((conn) => applyHostedTask(conn, hostedTask()))
    const remove = { table: 'hub_task', id: taskId, space: 'space-one', op: 'delete' as const }
    const add = {
      table: 'hub_task',
      id: taskId,
      space: 'space-two',
      op: 'upsert' as const,
      row: hostedTask({ project: 'two', project_name: 'two' }),
    }
    await pullHostedChanges({
      ...options,
      fetch: route({
        feed: () => page('after', order === 'delete-upsert' ? [remove, add] : [add, remove]),
      }),
      registeredProjects: registered,
    })
    expect(
      db()
        .query<{ project: string }, [string]>('SELECT project FROM task WHERE record_id=?')
        .get(taskId)?.project,
    ).toBe('two')
  })
}

test('a malformed record row leaves the feed cursor and cached task untouched', async () => {
  seedFeed()
  writeTransaction((conn) => applyHostedTask(conn, hostedTask()))
  await expect(
    pullHostedChanges({
      ...options,
      fetch: route({
        feed: () =>
          page('after', [
            {
              table: 'hub_task',
              id: taskId,
              space: 'space-one',
              op: 'upsert',
              row: { id: 'wrong' },
            },
          ]),
      }),
      registeredProjects: registered,
    }),
  ).rejects.toThrow()
  expect(stored('collect.hosted-record-changes.cursor')).toBe('before')
  expect(
    db().query<{ title: string }, [string]>('SELECT title FROM task WHERE record_id=?').get(taskId)
      ?.title,
  ).toBe('log task')
})

const taskComment = () => ({
  id: commentId,
  task_key: 'DEV-1240',
  task_id: taskId,
  project_name: 'one',
  body: 'child first',
  created_at: at,
  updated_at: at,
  deleted_at: null,
})

test('a child before its parent on one record-feed page applies after the parent', async () => {
  seedFeed()
  const calls: Array<{ path: string; space: string | null; after: string | null }> = []
  const report = await pullHostedChanges({
    ...options,
    fetch: route({
      calls,
      feed: () =>
        page('after', [
          {
            table: 'hub_task_comment',
            id: commentId,
            space: 'space-one',
            op: 'upsert',
            row: taskComment(),
          },
          { table: 'hub_task', id: taskId, space: 'space-one', op: 'upsert', row: hostedTask() },
        ]),
    }),
    registeredProjects: registered,
  })
  expect(calls.map((call) => call.path)).toEqual(['/v1/tasks/identity', '/v1/changes'])
  expect(db().query('SELECT task_record_id FROM task_comment').get()).toEqual({
    task_record_id: taskId,
  })
  expect(familyReport(report, 'task').upsertsChanged).toBe(2)
})

test('a child whose parent is on a later page fetches and applies the parent first', async () => {
  seedFeed()
  const calls: Array<{ path: string; space: string | null; after: string | null }> = []
  const report = await pullHostedChanges({
    ...options,
    fetch: route({
      calls,
      feed: (_after, call) =>
        call === 0
          ? page(
              'middle',
              [
                {
                  table: 'hub_task_comment',
                  id: commentId,
                  space: 'space-one',
                  op: 'upsert',
                  row: taskComment(),
                },
              ],
              true,
            )
          : page('after', [
              {
                table: 'hub_task',
                id: taskId,
                space: 'space-one',
                op: 'upsert',
                row: hostedTask(),
              },
            ]),
      getTask: () => Response.json({ task: hostedTask(), comments: [], documents: [] }),
    }),
    registeredProjects: registered,
  })
  expect(calls.map((call) => call.path)).toEqual([
    '/v1/tasks/identity',
    '/v1/changes',
    `/v1/tasks/${taskId}`,
    '/v1/changes',
  ])
  expect(db().query('SELECT task_record_id FROM task_comment').get()).toEqual({
    task_record_id: taskId,
  })
  expect(familyReport(report, 'task')).toMatchObject({ upsertsChanged: 1, upsertsNoop: 1 })
})

test('a child without a live hosted parent is skipped while the record cursor advances', async () => {
  seedFeed()
  const report = await pullHostedChanges({
    ...options,
    fetch: route({
      feed: () =>
        page('after', [
          {
            table: 'hub_task_comment',
            id: commentId,
            space: 'space-one',
            op: 'upsert',
            row: taskComment(),
          },
        ]),
      getTask: () => Response.json({ error: 'task not found' }, { status: 404 }),
    }),
    registeredProjects: registered,
  })
  expect(db().query('SELECT 1 FROM task_comment').get()).toBeNull()
  expect(stored('collect.hosted-record-changes.cursor')).toBe('after')
  expect(familyReport(report, 'task').absentParentSkipped).toBe(1)
})
