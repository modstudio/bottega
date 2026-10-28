import { afterAll, beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { formatCollectLeg, hostedCollectLegs } from './collect.ts'
import { db, writeTransaction } from './db.ts'
import { MAX_HOSTED_CHANGE_PAGES_PER_PASS, pullHostedTaskChanges } from './hosted-change-cache.ts'
import { HOSTED_CHANGES_CURSOR_KEY } from './hosted-task-change-family.ts'
import type { HostedTask } from './hosted-tasks.ts'
import { queueHostedChange } from './outbox.ts'
import { applyHostedTask } from './task-cache.ts'
import type { HostedSpaceChangePage } from './task-client.ts'

beforeEach(resetFixtureStore)
afterAll(resetFixtureStore)

const at = '2026-10-09T12:00:00.000Z'
const taskId = '01990000-0000-7000-8000-000000001240'
const commentId = '01990000-0000-7000-8000-000000001241'
const documentId = '01990000-0000-7000-8000-000000001242'
const eventId = '01990000-0000-7000-8000-000000001243'
const optionsBase = {
  baseUrl: 'https://hub.example.test',
  token: 'session',
} as const

const registeredOneTwo = [
  { name: 'one', settings: { space: 'one' } },
  { name: 'two', settings: { space: 'two' } },
]

const identityBody = (capabilities: Record<string, boolean> = { spaceChanges: true }) => ({
  userId: 'user-1',
  activeSpaceId: 'space-one',
  memberships: [
    { spaceId: 'space-one', slug: 'one' },
    { spaceId: 'space-two', slug: 'two' },
  ],
  capabilities,
})

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

const emptyTasks = (cursor: string) => ({
  tasks: [] as HostedTask[],
  comments: [],
  documents: [],
  statusEvents: [],
  cursor,
})

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

const cursor = (spaceId: string) =>
  db()
    .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?')
    .get(`${HOSTED_CHANGES_CURSOR_KEY}.${spaceId}`)?.value ?? null

const snapshotCursor = (spaceId: string) => {
  const value = db()
    .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?')
    .get(`${HOSTED_CHANGES_CURSOR_KEY}.snapshot.${spaceId}`)?.value
  return value ? (JSON.parse(value) as { head: number; cursor: string | null }) : null
}

const storeChangeCursor = (spaceId: string, value: string) => {
  writeTransaction((conn) => {
    conn
      .query(
        `INSERT INTO setting(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(`${HOSTED_CHANGES_CURSOR_KEY}.${spaceId}`, value)
  })
}

const seedTask = (project = 'one') => {
  writeTransaction((conn) => {
    applyHostedTask(conn, hostedTask({ project, project_name: project }))
  })
}

const insertChildren = () => {
  writeTransaction((conn) => {
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
}

type FetchCalls = Array<{
  path: string
  space: string | null
  after: string | null
  cursor: string | null
}>

const routeFetch = (opts: {
  capabilities?: Record<string, boolean>
  activeSpaceId?: string
  tasks?: (space: string | null, taskCursor: string | null) => unknown | Response
  changes?: (space: string | null, after: string | null) => unknown | Response
  calls?: FetchCalls
}) => {
  const calls = opts.calls ?? []
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const space = new Headers(init?.headers).get('x-record-space')
    if (url.pathname === '/v1/tasks/identity') {
      calls.push({ path: url.pathname, space: null, after: null, cursor: null })
      return Response.json({
        ...identityBody(opts.capabilities ?? { spaceChanges: true }),
        ...(opts.activeSpaceId ? { activeSpaceId: opts.activeSpaceId } : {}),
      })
    }
    if (url.pathname === '/v1/changes') {
      const after = url.searchParams.get('after')
      calls.push({ path: url.pathname, space, after, cursor: null })
      const body = opts.changes?.(space, after) ?? changePage({ next: Number(after ?? 0) })
      return body instanceof Response ? body : Response.json(body)
    }
    const taskCursorValue = url.searchParams.get('cursor')
    calls.push({ path: url.pathname, space, after: null, cursor: taskCursorValue })
    const body = opts.tasks?.(space, taskCursorValue) ?? emptyTasks(`${space}-after`)
    return body instanceof Response ? body : Response.json(body)
  }
  return { fetch, calls }
}

const pull = (
  fetch: TaskFetch,
  registeredProjects: readonly { name: string; settings: { space?: string } }[] = [
    { name: 'one', settings: { space: 'one' } },
  ],
) =>
  pullHostedTaskChanges({
    ...optionsBase,
    fetch,
    registeredProjects,
  })

type TaskFetch = (input: string, init?: RequestInit) => Promise<Response>

test('no change-log capability fails the follower leg with the release remedy', async () => {
  const calls: FetchCalls = []
  const { fetch } = routeFetch({ capabilities: {}, calls })
  const request = {
    ...optionsBase,
    fetch,
    registeredProjects: [{ name: 'one', settings: { space: 'one' } }],
  }
  const results = await hostedCollectLegs(undefined, {
    correctIntervals: () => {},
    changes: () => pullHostedTaskChanges(request),
    noteChanges: async () => null,
    sendChanges: async () => null,
  })
  expect(results.find((result) => result.source === 'hosted task changes')).toEqual({
    source: 'hosted task changes',
    ok: false,
    durationMs: expect.any(Number),
    error:
      'the hosted hub does not serve the change log; release the hosted hub at or after the version that does',
  })
  expect(calls.filter((call) => call.path === '/v1/changes')).toEqual([])
  expect(cursor('space-one')).toBeNull()
})

test('first run reads head, full-pulls, and stores that head', async () => {
  const calls: FetchCalls = []
  const { fetch } = routeFetch({
    calls,
    changes: (_space, after) =>
      after === '0'
        ? changePage({ head: 12, next: 0, changes: [] })
        : changePage({
            head: 13,
            next: 13,
            changes: [
              {
                sequence: 13,
                table: 'hub_task_comment',
                id: commentId,
                op: 'upsert',
                row: {
                  id: commentId,
                  task_key: 'DEV-1240',
                  project_name: 'one',
                  body: 'written during snapshot',
                  created_at: at,
                  updated_at: at,
                  deleted_at: null,
                },
              },
            ],
          }),
    tasks: (_space, taskCursorValue) => {
      expect(taskCursorValue).toBeNull()
      return { ...emptyTasks('full'), tasks: [hostedTask()] }
    },
  })
  const report = await pull(fetch)
  expect(cursor('space-one')).toBe('13')
  expect(db().query(`SELECT 1 FROM task WHERE record_id=?`).get(taskId)).not.toBeNull()
  expect(db().query(`SELECT 1 FROM task_comment WHERE record_id=?`).get(commentId)).not.toBeNull()
  expect(report?.spaces).toEqual([
    {
      spaceId: 'space-one',
      upsertsChanged: 1,
      upsertsNoop: 0,
      deletesApplied: 0,
      deletesSkipped: 0,
      absentParentSkipped: 0,
      resets: 1,
    },
  ])
  expect(calls.map((call) => call.path)).toEqual([
    '/v1/tasks/identity',
    '/v1/changes',
    '/v1/tasks',
    '/v1/changes',
  ])
})

test('an interrupted first pull resumes after its last applied snapshot page', async () => {
  let firstCalls = 0
  const first = routeFetch({
    changes: () => changePage({ head: 12, next: 0 }),
    tasks: (_space, taskCursorValue) => {
      firstCalls++
      if (taskCursorValue === null)
        return {
          ...emptyTasks('page-one'),
          tasks: [hostedTask()],
          more: true,
        }
      return Response.json({ error: 'interrupted' }, { status: 503 })
    },
  })
  await expect(pull(first.fetch)).rejects.toThrow('interrupted')
  expect(firstCalls).toBe(2)
  expect(cursor('space-one')).toBeNull()
  expect(snapshotCursor('space-one')).toEqual({ head: 12, cursor: 'page-one' })
  expect(db().query(`SELECT 1 FROM task WHERE record_id=?`).get(taskId)).not.toBeNull()

  const resumedCursors: Array<string | null> = []
  const resumed = routeFetch({
    tasks: (_space, taskCursorValue) => {
      resumedCursors.push(taskCursorValue)
      return {
        ...emptyTasks('page-two'),
        tasks: [
          hostedTask({
            id: '01990000-0000-7000-8000-000000001250',
            key: 'DEV-1250',
          }),
        ],
        more: false,
      }
    },
  })
  await pull(resumed.fetch)
  expect(resumedCursors).toEqual(['page-one'])
  expect(snapshotCursor('space-one')).toBeNull()
  expect(cursor('space-one')).toBe('12')
  expect(db().query<{ count: number }, []>('SELECT count(*) count FROM task').get()?.count).toBe(2)
})

test('a later page applies upserts and advances the cursor in one transaction', async () => {
  storeChangeCursor('space-one', '12')
  const { fetch } = routeFetch({
    changes: () =>
      changePage({
        next: 15,
        changes: [{ sequence: 15, table: 'hub_task', id: taskId, op: 'upsert', row: hostedTask() }],
      }),
  })
  const report = await pull(fetch)
  expect(cursor('space-one')).toBe('15')
  expect(
    db().query<{ title: string }, [string]>(`SELECT title FROM task WHERE record_id=?`).get(taskId)
      ?.title,
  ).toBe('log task')
  expect(report?.upsertsChanged).toBe(1)
  expect(report?.upsertsNoop).toBe(0)
})

test('a later page preserves pending fields and advances past a pending document delete', async () => {
  storeChangeCursor('space-one', '12')
  seedTask()
  insertChildren()
  writeTransaction((conn) => {
    conn.query(`UPDATE task SET title='pending machine title' WHERE record_id=?`).run(taskId)
    queueHostedChange(conn, 'hub_task', taskId, 'upsert', at, ['title'])
    queueHostedChange(conn, 'hub_task_document', documentId, 'delete', at)
    conn.query(`DELETE FROM task_document WHERE record_id=?`).run(documentId)
  })
  const { fetch } = routeFetch({
    changes: () =>
      changePage({
        next: 16,
        changes: [
          {
            sequence: 15,
            table: 'hub_task',
            id: taskId,
            op: 'upsert',
            row: hostedTask({ title: 'hosted title', status: 'active', status_category: 'active' }),
          },
          {
            sequence: 16,
            table: 'hub_task_document',
            id: documentId,
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
        ],
      }),
  })
  await pull(fetch)
  expect(cursor('space-one')).toBe('16')
  expect(db().query(`SELECT title,status FROM task WHERE record_id=?`).get(taskId)).toEqual({
    title: 'pending machine title',
    status: 'active',
  })
  expect(db().query(`SELECT 1 FROM task_document WHERE record_id=?`).get(documentId)).toBeNull()
})

test('a throwing apply leaves the change cursor unmoved', async () => {
  storeChangeCursor('space-one', '12')
  seedTask()
  const { fetch } = routeFetch({
    changes: () =>
      changePage({
        next: 16,
        changes: [
          {
            sequence: 16,
            table: 'hub_task_document',
            id: documentId,
            op: 'upsert',
            row: {
              id: documentId,
              task_key: 'DEV-1240',
              project_name: 'one',
              number: null,
              role: 'handoff',
              title: 'handoff',
              body: 'body',
              version: 'v1',
              created_at: at,
              updated_at: at,
              deleted_at: null,
            },
          },
        ],
      }),
  })
  await expect(pull(fetch)).rejects.toThrow('live task document')
  expect(cursor('space-one')).toBe('12')
  expect(db().query(`SELECT 1 FROM task_document WHERE record_id=?`).get(documentId)).toBeNull()
})

test('an identical log upsert is a no-op; a new one is changed', async () => {
  storeChangeCursor('space-one', '12')
  writeTransaction((conn) => {
    applyHostedTask(conn, hostedTask())
  })
  const { fetch } = routeFetch({
    changes: () =>
      changePage({
        next: 18,
        changes: [
          { sequence: 17, table: 'hub_task', id: taskId, op: 'upsert', row: hostedTask() },
          {
            sequence: 18,
            table: 'hub_task',
            id: '01990000-0000-7000-8000-000000001249',
            op: 'upsert',
            row: hostedTask({
              id: '01990000-0000-7000-8000-000000001249',
              key: 'DEV-1249',
              title: 'fresh',
            }),
          },
        ],
      }),
  })
  const report = await pull(fetch)
  expect(report?.upsertsNoop).toBe(1)
  expect(report?.upsertsChanged).toBe(1)
})

test('a pulled git task keeps equal plain dates byte-for-byte and queues nothing', async () => {
  storeChangeCursor('space-one', '12')
  const plainDate = '2026-10-09'
  writeTransaction((conn) => {
    applyHostedTask(
      conn,
      hostedTask({ source: 'git', opened_at: plainDate, updated_at: plainDate }),
    )
  })
  const before = db().query('SELECT * FROM task WHERE record_id=?').get(taskId)
  const { fetch } = routeFetch({
    changes: () =>
      changePage({
        next: 13,
        changes: [
          {
            sequence: 13,
            table: 'hub_task',
            id: taskId,
            op: 'upsert',
            row: hostedTask({
              source: 'git',
              opened_at: `${plainDate}T00:00:00.000Z`,
              updated_at: `${plainDate}T00:00:00.000Z`,
            }),
          },
        ],
      }),
  })

  const report = await pull(fetch)

  expect(db().query('SELECT * FROM task WHERE record_id=?').get(taskId)).toEqual(before)
  expect(db().query('SELECT 1 FROM hosted_outbox').all()).toEqual([])
  expect(report?.upsertsNoop).toBe(1)
})

test('a delete from the row own space removes the row and its children', async () => {
  storeChangeCursor('space-one', '12')
  seedTask()
  insertChildren()
  const { fetch } = routeFetch({
    changes: () =>
      changePage({
        next: 19,
        changes: [{ sequence: 19, table: 'hub_task', id: taskId, op: 'delete' }],
      }),
  })
  const report = await pull(fetch)
  expect(db().query(`SELECT 1 FROM task WHERE record_id=?`).get(taskId)).toBeNull()
  expect(db().query(`SELECT 1 FROM task_comment WHERE record_id=?`).get(commentId)).toBeNull()
  expect(db().query(`SELECT 1 FROM task_document WHERE record_id=?`).get(documentId)).toBeNull()
  expect(db().query(`SELECT 1 FROM task_status_event WHERE record_id=?`).get(eventId)).toBeNull()
  expect(report?.deletesApplied).toBe(1)
  expect(report?.deletesSkipped).toBe(0)
})

test('a hosted task tombstone gives task-only intervals the task project before deletion', () => {
  const projectId = '01990000-0000-7000-8000-000000001101'
  const row = hostedTask({ project: 'alpha', project_name: 'alpha', projectId })
  writeTransaction((conn) => {
    applyHostedTask(conn, row)
    conn
      .query(
        `INSERT INTO interval
         (record_id,task_key,task_record_id,source,start_at,end_at,ref)
         VALUES ('task-only-interval',?,?, 'orch',?,?, 'task-only-interval')`,
      )
      .run(row.key, row.id, at, at)
    applyHostedTask(conn, { ...row, deleted_at: at })
  })

  expect(db().query(`SELECT 1 FROM task WHERE record_id=?`).get(taskId)).toBeNull()
  expect(
    db()
      .query(`SELECT task_record_id,project,project_record_id FROM interval WHERE record_id=?`)
      .get('task-only-interval'),
  ).toEqual({ task_record_id: null, project: 'alpha', project_record_id: projectId })
})

test('a delete from another space leaves the row and counts as skipped', async () => {
  storeChangeCursor('space-one', '12')
  storeChangeCursor('space-two', '12')
  seedTask('one')
  const { fetch } = routeFetch({
    changes: (space) => {
      if (space !== 'space-two') return changePage({ next: 12 })
      return changePage({
        next: 19,
        changes: [{ sequence: 19, table: 'hub_task', id: taskId, op: 'delete' }],
      })
    },
  })
  const report = await pullHostedTaskChanges({
    ...optionsBase,
    fetch,
    registeredProjects: registeredOneTwo,
  })
  expect(db().query(`SELECT 1 FROM task WHERE record_id=?`).get(taskId)).not.toBeNull()
  const two = report?.spaces.find((space) => space.spaceId === 'space-two')
  expect(two?.deletesSkipped).toBe(1)
  expect(two?.deletesApplied).toBe(0)
})

test('delete then upsert across two spaces leaves the row in the new space', async () => {
  storeChangeCursor('space-one', '12')
  storeChangeCursor('space-two', '12')
  seedTask('one')
  let onePages = 0
  let twoPages = 0
  const { fetch } = routeFetch({
    changes: (space) => {
      if (space === 'space-one') {
        onePages += 1
        return changePage({
          next: 13,
          changes: [{ sequence: 13, table: 'hub_task', id: taskId, op: 'delete' }],
        })
      }
      twoPages += 1
      return changePage({
        next: 13,
        changes: [
          {
            sequence: 13,
            table: 'hub_task',
            id: taskId,
            op: 'upsert',
            row: hostedTask({ project: 'two', project_name: 'two' }),
          },
        ],
      })
    },
  })
  await pullHostedTaskChanges({
    ...optionsBase,
    fetch,
    registeredProjects: registeredOneTwo,
  })
  expect(onePages).toBe(1)
  expect(twoPages).toBe(1)
  expect(
    db()
      .query<{ project: string }, [string]>(`SELECT project FROM task WHERE record_id=?`)
      .get(taskId)?.project,
  ).toBe('two')
})

test('upsert then delete across two spaces leaves the row in the new space', async () => {
  storeChangeCursor('space-one', '12')
  storeChangeCursor('space-two', '12')
  seedTask('one')
  const { fetch } = routeFetch({
    changes: (space) => {
      if (space === 'space-two')
        return changePage({
          next: 13,
          changes: [
            {
              sequence: 13,
              table: 'hub_task',
              id: taskId,
              op: 'upsert',
              row: hostedTask({ project: 'two', project_name: 'two' }),
            },
          ],
        })
      return changePage({ next: 12 })
    },
  })
  await pullHostedTaskChanges({
    ...optionsBase,
    fetch,
    registeredProjects: [{ name: 'two', settings: { space: 'two' } }],
  })
  expect(
    db()
      .query<{ project: string }, [string]>(`SELECT project FROM task WHERE record_id=?`)
      .get(taskId)?.project,
  ).toBe('two')
  const { fetch: deleteFetch } = routeFetch({
    changes: (space) => {
      if (space === 'space-one')
        return changePage({
          next: 14,
          changes: [{ sequence: 14, table: 'hub_task', id: taskId, op: 'delete' }],
        })
      return changePage({ next: 13 })
    },
  })
  const report = await pullHostedTaskChanges({
    ...optionsBase,
    fetch: deleteFetch,
    registeredProjects: registeredOneTwo,
  })
  expect(
    db()
      .query<{ project: string }, [string]>(`SELECT project FROM task WHERE record_id=?`)
      .get(taskId)?.project,
  ).toBe('two')
  expect(report?.spaces.find((space) => space.spaceId === 'space-one')?.deletesSkipped).toBe(1)
})

test('resetRequired runs the start path again', async () => {
  storeChangeCursor('space-one', '5')
  seedTask()
  writeTransaction((conn) => {
    conn.query("UPDATE task SET title='pending title' WHERE record_id=?").run(taskId)
    queueHostedChange(conn, 'hub_task', taskId, 'upsert', at, ['title'])
  })
  const calls: FetchCalls = []
  const { fetch } = routeFetch({
    calls,
    changes: (_space, after) => {
      if (after === '5') return changePage({ head: 40, next: 5, resetRequired: true })
      return changePage({ head: 40, next: Number(after ?? 0) })
    },
    tasks: (_space, taskCursorValue) => {
      expect(taskCursorValue).toBeNull()
      return { ...emptyTasks('reset-full'), tasks: [hostedTask({ title: 'reset' })] }
    },
  })
  await pull(fetch)
  expect(cursor('space-one')).toBe('40')
  expect(
    db().query<{ title: string }, [string]>(`SELECT title FROM task WHERE record_id=?`).get(taskId)
      ?.title,
  ).toBe('pending title')
  expect(calls.filter((call) => call.path === '/v1/tasks')).toHaveLength(1)
})

test('a failing log leg is reported independently', async () => {
  const { fetch } = routeFetch({
    changes: () => Response.json({ error: 'offline' }, { status: 503 }),
  })
  const request = {
    ...optionsBase,
    fetch,
    registeredProjects: [{ name: 'one', settings: { space: 'one' } }],
  }
  const results = await hostedCollectLegs(undefined, {
    correctIntervals: () => {},
    changes: () => pullHostedTaskChanges(request),
    noteChanges: async () => null,
    sendChanges: async () => null,
  })
  expect(cursor('space-one')).toBeNull()
  expect(results).toEqual([
    {
      source: 'hosted outbox',
      ok: true,
      durationMs: expect.any(Number),
      hostedOutbox: {
        queued: 0,
        sent: 0,
        rejected: 0,
        quarantined: 0,
        dropped: 0,
        waitingOnRouting: {},
        waitingOnHostedHub: {},
        skippedCapability: false,
      },
    },
    {
      source: 'hosted task changes',
      ok: false,
      durationMs: expect.any(Number),
      error:
        'hosted task change pulls failed: space-one: hosted hub refused the request (503): offline',
    },
  ])
})

test('the collect line prints the change counts and resets per space', () => {
  expect(
    formatCollectLeg({
      source: 'hosted task changes',
      ok: true,
      durationMs: 0,
      hostedChanges: {
        upsertsChanged: 3,
        upsertsNoop: 10,
        deletesApplied: 1,
        deletesSkipped: 0,
        absentParentSkipped: 0,
        resets: 1,
        reportAbsentParentSkips: true,
        spaces: [
          {
            spaceId: 'space-one',
            upsertsChanged: 3,
            upsertsNoop: 10,
            deletesApplied: 1,
            deletesSkipped: 0,
            absentParentSkipped: 0,
            resets: 1,
          },
        ],
      },
    }),
  ).toBe(
    'hosted task changes space-one 3 changed, 10 no-op, 1 deleted, 0 skipped, 0 absent-parent skipped, 1 reset',
  )
})

test('the page bound stops a pass and the next pass continues from the stored cursor', async () => {
  storeChangeCursor('space-one', '0')
  const afters: string[] = []
  const { fetch } = routeFetch({
    changes: (_space, after) => {
      afters.push(after ?? '')
      return changePage({ head: 100, next: Number(after) + 1, more: true })
    },
  })
  await pull(fetch)
  expect(afters).toHaveLength(MAX_HOSTED_CHANGE_PAGES_PER_PASS)
  expect(afters[0]).toBe('0')
  expect(afters.at(-1)).toBe(String(MAX_HOSTED_CHANGE_PAGES_PER_PASS - 1))
  expect(cursor('space-one')).toBe(String(MAX_HOSTED_CHANGE_PAGES_PER_PASS))
  afters.length = 0
  await pull(fetch)
  expect(afters[0]).toBe(String(MAX_HOSTED_CHANGE_PAGES_PER_PASS))
})

const followPage = () =>
  changePage({
    next: 15,
    changes: [{ sequence: 15, table: 'hub_task', id: taskId, op: 'upsert', row: hostedTask() }],
  })

const malformedPages: Array<{ name: string; page: unknown; error: RegExp }> = [
  { name: 'head', page: { ...followPage(), head: -1 }, error: /malformed: head/ },
  { name: 'next', page: { ...followPage(), next: 1.5 }, error: /malformed: next/ },
  {
    name: 'sequence',
    page: {
      ...followPage(),
      changes: [{ sequence: -1, table: 'hub_task', id: taskId, op: 'delete' }],
    },
    error: /malformed: changes\[0\]\.sequence/,
  },
  { name: 'oldest', page: { ...followPage(), oldest: -1 }, error: /malformed: oldest/ },
  { name: 'more', page: { ...followPage(), more: 1 }, error: /malformed: more/ },
  {
    name: 'resetRequired',
    page: { ...followPage(), resetRequired: 1 },
    error: /malformed: resetRequired/,
  },
  {
    name: 'next below after',
    page: { ...followPage(), next: 11 },
    error: /malformed: next 11 is below after 12/,
  },
  {
    name: 'next above head',
    page: { ...followPage(), head: 10 },
    error: /malformed: next 15 is above head 10/,
  },
  {
    name: 'table',
    page: {
      ...followPage(),
      changes: [{ sequence: 15, table: 'hub_note', id: taskId, op: 'delete' }],
    },
    error: /malformed: changes\[0\]\.table/,
  },
  {
    name: 'op',
    page: {
      ...followPage(),
      changes: [{ sequence: 15, table: 'hub_task', id: taskId, op: 'patch' }],
    },
    error: /malformed: changes\[0\]\.op/,
  },
  {
    name: 'id',
    page: {
      ...followPage(),
      changes: [{ sequence: 15, table: 'hub_task', op: 'delete' }],
    },
    error: /malformed: changes\[0\]\.id/,
  },
  {
    name: 'upsert row',
    page: {
      ...followPage(),
      changes: [{ sequence: 15, table: 'hub_task', id: taskId, op: 'upsert' }],
    },
    error: /malformed: changes\[0\] upsert must include a row/,
  },
  {
    name: 'upsert row id',
    page: {
      ...followPage(),
      changes: [
        {
          sequence: 15,
          table: 'hub_task',
          id: taskId,
          op: 'upsert',
          row: hostedTask({ id: commentId }),
        },
      ],
    },
    error: /malformed: changes\[0\] row id must equal the change id/,
  },
  {
    name: 'delete row',
    page: {
      ...followPage(),
      changes: [{ sequence: 15, table: 'hub_task', id: taskId, op: 'delete', row: hostedTask() }],
    },
    error: /malformed: changes\[0\] delete must not include a row/,
  },
  {
    name: 'resetRequired changes',
    page: { ...followPage(), resetRequired: true },
    error: /malformed: resetRequired page must not include changes/,
  },
  {
    name: 'sequence not greater than after',
    page: {
      ...followPage(),
      changes: [{ sequence: 1, table: 'hub_task', id: taskId, op: 'delete' }],
    },
    error: /malformed: changes\[0\]\.sequence 1 is not greater than after 12/,
  },
  {
    name: 'sequence above next',
    page: {
      ...followPage(),
      changes: [{ sequence: 16, table: 'hub_task', id: taskId, op: 'delete' }],
    },
    error: /malformed: changes\[0\]\.sequence 16 is above next 15/,
  },
  {
    name: 'sequences not strictly increasing',
    page: {
      ...followPage(),
      changes: [
        { sequence: 15, table: 'hub_task', id: taskId, op: 'delete' },
        { sequence: 15, table: 'hub_task', id: commentId, op: 'delete' },
      ],
    },
    error: /malformed: changes\[1\]\.sequence 15 does not increase from changes\[0\]\.sequence 15/,
  },
  {
    name: 'more without advancing next',
    page: { ...followPage(), next: 12, more: true, changes: [] },
    error: /malformed: more is true but next 12 is not greater than after 12/,
  },
]

for (const { name, page, error } of malformedPages) {
  test(`a malformed ${name} refuses and leaves the cursor and rows untouched`, async () => {
    storeChangeCursor('space-one', '12')
    seedTask()
    const { fetch } = routeFetch({ changes: () => page as HostedSpaceChangePage })
    await expect(pull(fetch)).rejects.toThrow(error)
    expect(cursor('space-one')).toBe('12')
    expect(db().query(`SELECT 1 FROM task WHERE record_id=?`).get(taskId)).not.toBeNull()
  })
}

test('a reset page may have next above head', async () => {
  storeChangeCursor('space-one', '5')
  const { fetch } = routeFetch({
    changes: (_space, after) => {
      if (after === '5') return changePage({ head: 3, next: 5, resetRequired: true })
      return changePage({ head: 3, next: Number(after ?? 0) })
    },
    tasks: (_space, taskCursorValue) => {
      expect(taskCursorValue).toBeNull()
      return { ...emptyTasks('reset-full'), tasks: [hostedTask({ title: 'reset-above' })] }
    },
  })
  await pull(fetch)
  expect(cursor('space-one')).toBe('3')
  expect(
    db().query<{ title: string }, [string]>(`SELECT title FROM task WHERE record_id=?`).get(taskId)
      ?.title,
  ).toBe('reset-above')
})
