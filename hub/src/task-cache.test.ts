import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { applyHostedTaskChanges, pullHostedTasks } from './task-cache.ts'

const registered = [
  { name: 'one', settings: { space: 'one' } },
  { name: 'two', settings: { space: 'two' } },
  { name: 'refused', settings: { space: 'missing' } },
]

const emptyChanges = (cursor: string) => ({
  tasks: [],
  comments: [],
  documents: [],
  statusEvents: [],
  cursor,
})

const cursor = (key: string) =>
  db().query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?').get(key)
    ?.value ?? null

beforeEach(resetFixtureStore)

test('a batch deleting a task and its document applies and advances the cursor', () => {
  const at = '2026-10-08T12:00:00.000Z'
  const taskId = '01990000-0000-7000-8000-000000001214'
  const documentId = '01990000-0000-7000-8000-000000001215'
  writeTransaction((conn) => {
    conn
      .query(`INSERT INTO task(record_id,key,project,source,first_seen,last_seen)
      VALUES (?,'DEV-1214','workshop','local',?,?)`)
      .run(taskId, at, at)
    conn
      .query(`INSERT INTO task_document
      (record_id,task_key,task_record_id,number,title,body,version,created_at,updated_at)
      VALUES (?,'DEV-1214',?,1,'handoff','body','v1',?,?)`)
      .run(documentId, taskId, at, at)
  })
  applyHostedTaskChanges({
    tasks: [
      {
        id: taskId,
        key: 'DEV-1214',
        project: 'workshop',
        project_name: 'workshop',
        title: 'deleted',
        status: 'done',
        status_category: 'done',
        parent_key: null,
        body: null,
        assignee: null,
        opened_at: at,
        closed_at: at,
        source: 'local',
        first_seen: at,
        last_seen: at,
        created_at: at,
        updated_at: at,
        deleted_at: at,
        next_document_number: 2,
      },
    ],
    comments: [],
    documents: [
      {
        id: documentId,
        task_key: 'DEV-1214',
        project_name: 'workshop',
        number: null,
        role: 'handoff',
        title: 'handoff',
        body: 'body',
        version: 'v1',
        created_at: at,
        updated_at: at,
        deleted_at: at,
      },
    ],
    statusEvents: [],
    cursor: 'deleted-after',
  })
  expect(db().query(`SELECT 1 FROM task WHERE record_id=?`).get(taskId)).toBeNull()
  expect(db().query(`SELECT 1 FROM task_document WHERE record_id=?`).get(documentId)).toBeNull()
  expect(cursor('collect.hosted-tasks.cursor')).toBe('deleted-after')
})

test('task pull requests every project destination and the distinct active space', async () => {
  writeTransaction((conn) => {
    const put = conn.query('INSERT INTO setting(key,value) VALUES (?,?)')
    put.run('collect.hosted-tasks.cursor', 'active-before')
    put.run('collect.hosted-tasks.cursor.space-one', 'one-before')
  })
  const requests: Array<{ space: string | null; cursor: string | null }> = []
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    if (url.pathname === '/v1/tasks/identity')
      return Response.json({
        userId: 'user-1',
        activeSpaceId: 'space-active',
        memberships: [
          { spaceId: 'space-active', slug: 'active' },
          { spaceId: 'space-one', slug: 'one' },
          { spaceId: 'space-two', slug: 'two' },
        ],
      })
    const space = new Headers(init?.headers).get('x-record-space')
    requests.push({ space, cursor: url.searchParams.get('cursor') })
    return Response.json(emptyChanges(`${space}-after`))
  }

  await pullHostedTasks({
    baseUrl: 'https://hub.example.test',
    token: 'session',
    fetch,
    registeredProjects: registered,
  })

  expect(requests).toEqual([
    { space: 'space-active', cursor: 'active-before' },
    { space: 'space-one', cursor: 'one-before' },
    { space: 'space-two', cursor: null },
  ])
  expect(cursor('collect.hosted-tasks.cursor')).toBeNull()
  expect(cursor('collect.hosted-tasks.cursor.space-active')).toBe('space-active-after')
  expect(cursor('collect.hosted-tasks.cursor.space-one')).toBe('space-one-after')
  expect(cursor('collect.hosted-tasks.cursor.space-two')).toBe('space-two-after')
})

test('a failed space keeps its cursor while every other space advances', async () => {
  writeTransaction((conn) => {
    const put = conn.query('INSERT INTO setting(key,value) VALUES (?,?)')
    put.run('collect.hosted-tasks.cursor.space-one', 'one-before')
  })
  const attempted: string[] = []
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    if (url.pathname === '/v1/tasks/identity')
      return Response.json({
        userId: 'user-1',
        activeSpaceId: 'space-active',
        memberships: [
          { spaceId: 'space-active', slug: 'active' },
          { spaceId: 'space-one', slug: 'one' },
          { spaceId: 'space-two', slug: 'two' },
        ],
      })
    const space = new Headers(init?.headers).get('x-record-space')!
    attempted.push(space)
    if (space === 'space-one') return Response.json({ error: 'offline' }, { status: 503 })
    return Response.json(emptyChanges(`${space}-after`))
  }

  await expect(
    pullHostedTasks({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch,
      registeredProjects: registered,
    }),
  ).rejects.toThrow(
    'hosted task pulls failed: space-one: hosted hub refused the request (503): offline',
  )

  expect(attempted).toEqual(['space-active', 'space-one', 'space-two'])
  expect(cursor('collect.hosted-tasks.cursor.space-active')).toBe('space-active-after')
  expect(cursor('collect.hosted-tasks.cursor.space-one')).toBe('one-before')
  expect(cursor('collect.hosted-tasks.cursor.space-two')).toBe('space-two-after')
})

test('space cursors remain attached to their space when the active space changes', async () => {
  writeTransaction((conn) => {
    conn
      .query('INSERT INTO setting(key,value) VALUES (?,?)')
      .run('collect.hosted-tasks.cursor', 'legacy-before')
  })
  let activeSpaceId = 'space-a'
  const requests: Array<{ space: string | null; cursor: string | null }> = []
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    if (url.pathname === '/v1/tasks/identity')
      return Response.json({
        userId: 'user-1',
        activeSpaceId,
        memberships: [
          { spaceId: 'space-a', slug: 'a' },
          { spaceId: 'space-b', slug: 'b' },
        ],
      })
    const space = new Headers(init?.headers).get('x-record-space')
    requests.push({ space, cursor: url.searchParams.get('cursor') })
    return Response.json(emptyChanges(`${space}-after-${requests.length}`))
  }
  const options = {
    baseUrl: 'https://hub.example.test',
    token: 'session',
    fetch,
    registeredProjects: [] as const,
  }

  await pullHostedTasks(options)
  activeSpaceId = 'space-b'
  await pullHostedTasks(options)
  activeSpaceId = 'space-a'
  await pullHostedTasks(options)

  expect(requests).toEqual([
    { space: 'space-a', cursor: 'legacy-before' },
    { space: 'space-b', cursor: null },
    { space: 'space-a', cursor: 'space-a-after-1' },
  ])
  expect(cursor('collect.hosted-tasks.cursor.space-a')).toBe('space-a-after-3')
  expect(cursor('collect.hosted-tasks.cursor.space-b')).toBe('space-b-after-2')
  expect(cursor('collect.hosted-tasks.cursor')).toBeNull()
})
