import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { hostedChangeLegLine, pullHostedTaskChanges } from './hosted-change-cache.ts'
import { HOSTED_CHANGES_CURSOR_KEY } from './hosted-task-change-family.ts'
import type { HostedTask } from './hosted-tasks.ts'
import { applyHostedTaskRows } from './task-cache.ts'
import type { HostedSpaceChange, HostedSpaceChangePage } from './task-client.ts'

beforeEach(resetFixtureStore)

const spaceId = '01990000-0000-7000-8000-000000000001'
const taskId = '01990000-0000-7000-8000-000000001417'
const commentId = '01990000-0000-7000-8000-000000001418'
const documentId = '01990000-0000-7000-8000-000000001419'
const eventId = '01990000-0000-7000-8000-000000001420'
const cachedTaskId = '01990000-0000-7000-8000-000000001421'
const at = '2026-10-20T00:00:00.000Z'

const task = (): HostedTask => ({
  id: taskId,
  key: 'DEV-1417',
  project: 'one',
  project_name: 'one',
  title: 'parent',
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
})

const comment = () => ({
  id: commentId,
  task_key: 'DEV-1417',
  task_id: taskId,
  project_name: 'one',
  body: 'child first',
  created_at: at,
  updated_at: at,
  deleted_at: null,
})

function page(next: number, changes: HostedSpaceChange[], more = false): HostedSpaceChangePage {
  return { head: 2, oldest: 1, next, more, resetRequired: false, changes }
}

function storeCursor() {
  writeTransaction((conn) =>
    conn
      .query('INSERT INTO setting(key,value) VALUES (?,?)')
      .run(`${HOSTED_CHANGES_CURSOR_KEY}.${spaceId}`, '0'),
  )
}

function fetchFor(options: {
  changes: (after: string) => HostedSpaceChangePage
  parent?: () => Response
  paths?: string[]
}) {
  return async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    options.paths?.push(url.pathname)
    if (url.pathname === '/v1/tasks/identity')
      return Response.json({
        userId: 'user-1',
        activeSpaceId: spaceId,
        memberships: [{ spaceId, slug: 'one' }],
        capabilities: { spaceChanges: true },
      })
    expect(new Headers(init?.headers).get('x-record-space')).toBe(spaceId)
    if (url.pathname === '/v1/changes')
      return Response.json(options.changes(url.searchParams.get('after') ?? '0'))
    if (url.pathname === `/v1/tasks/${taskId}`)
      return options.parent?.() ?? Response.json({ task: task(), comments: [], documents: [] })
    throw new Error(`unexpected request ${url.pathname}`)
  }
}

function pull(fetch: (input: string, init?: RequestInit) => Promise<Response>) {
  return pullHostedTaskChanges({
    baseUrl: 'https://hub.example.test',
    fetch,
    token: 'session',
    registeredProjects: [{ name: 'one', settings: { space: 'one' } }],
  })
}

test('a comment before its uncached task on one page applies after the task', async () => {
  storeCursor()
  const paths: string[] = []
  const report = await pull(
    fetchFor({
      paths,
      changes: () =>
        page(2, [
          {
            sequence: 1,
            table: 'hub_task_comment',
            id: commentId,
            op: 'upsert',
            row: comment(),
          },
          {
            sequence: 2,
            table: 'hub_task',
            id: taskId,
            op: 'upsert',
            row: task(),
          },
        ]),
    }),
  )

  expect(paths).toEqual(['/v1/tasks/identity', '/v1/changes'])
  expect(db().query('SELECT task_record_id FROM task_comment').get()).toEqual({
    task_record_id: taskId,
  })
  expect(report.upsertsChanged).toBe(2)
})

test('a comment whose task change is on a later page fetches and applies the task first', async () => {
  storeCursor()
  const paths: string[] = []
  const report = await pull(
    fetchFor({
      paths,
      changes: (after) =>
        after === '0'
          ? page(
              1,
              [
                {
                  sequence: 1,
                  table: 'hub_task_comment',
                  id: commentId,
                  op: 'upsert',
                  row: comment(),
                },
              ],
              true,
            )
          : page(2, [
              {
                sequence: 2,
                table: 'hub_task',
                id: taskId,
                op: 'upsert',
                row: task(),
              },
            ]),
    }),
  )

  expect(paths).toEqual(['/v1/tasks/identity', '/v1/changes', `/v1/tasks/${taskId}`, '/v1/changes'])
  expect(db().query('SELECT task_record_id FROM task_comment').get()).toEqual({
    task_record_id: taskId,
  })
  expect(report.upsertsChanged).toBe(1)
  expect(report.upsertsNoop).toBe(1)
})

test('a comment with no live hosted parent is skipped and counted while the cursor advances', async () => {
  storeCursor()
  const report = await pull(
    fetchFor({
      changes: () =>
        page(1, [
          {
            sequence: 1,
            table: 'hub_task_comment',
            id: commentId,
            op: 'upsert',
            row: comment(),
          },
        ]),
      parent: () => Response.json({ error: 'task not found' }, { status: 404 }),
    }),
  )

  expect(db().query('SELECT 1 FROM task_comment').get()).toBeNull()
  expect(
    db()
      .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?')
      .get(`${HOSTED_CHANGES_CURSOR_KEY}.${spaceId}`)?.value,
  ).toBe('1')
  expect(report.absentParentSkipped).toBe(1)
  expect(hostedChangeLegLine(report)).toContain('1 absent-parent skipped')
})

test.each([
  {
    label: 'comment',
    table: 'hub_task_comment',
    machineTable: 'task_comment',
    row: comment(),
  },
  {
    label: 'document',
    table: 'hub_task_document',
    machineTable: 'task_document',
    row: {
      id: documentId,
      task_key: 'DEV-1417',
      task_id: taskId,
      project_name: 'one',
      number: 1,
      role: 'handoff',
      title: 'handoff',
      body: 'body',
      version: 'v1',
      created_at: at,
      updated_at: at,
      deleted_at: null,
    },
  },
  {
    label: 'status event',
    table: 'hub_task_status_event',
    machineTable: 'task_status_event',
    row: {
      id: eventId,
      task_key: 'DEV-1417',
      task_id: taskId,
      project_name: 'one',
      at,
      from_status: null,
      to_status: 'open',
      created_at: at,
      updated_at: at,
      deleted_at: null,
    },
  },
] as const)(
  'a $label is skipped when only a same-key task under another UUID is cached',
  async ({ table, machineTable, row }) => {
    storeCursor()
    writeTransaction((conn) =>
      applyHostedTaskRows(conn, {
        tasks: [{ ...task(), id: cachedTaskId }],
        comments: [],
        documents: [],
        statusEvents: [],
        cursor: '',
      }),
    )

    const report = await pull(
      fetchFor({
        changes: () =>
          page(1, [
            {
              sequence: 1,
              table,
              id: row.id,
              op: 'upsert',
              row,
            } as HostedSpaceChange,
          ]),
        parent: () => Response.json({ error: 'task not found' }, { status: 404 }),
      }),
    )

    expect(db().query(`SELECT 1 FROM ${machineTable}`).get()).toBeNull()
    expect(report.absentParentSkipped).toBe(1)
  },
)
