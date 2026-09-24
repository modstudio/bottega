import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { pushTasks, selectTaskPushRows } from './task-push.ts'

beforeEach(resetFixtureStore)

test('task push selects active-space projects and reports every skipped project and reason', () => {
  const task = (key: string, project_name: string) => ({
    key,
    project: project_name,
    project_name,
    source: 'mcp',
  })
  const child = (task_key: string, project_name: string) => ({ task_key, project_name })
  const input = {
    tasks: [
      task('DEF-1', 'defaulted'),
      task('SLUG-1', 'by-slug'),
      task('ID-1', 'by-id'),
      task('OTHER-1', 'other'),
      task('LOST-1', 'unknown-space'),
      task('ORPHAN-1', 'unregistered'),
    ],
    comments: [child('OTHER-1', 'other')],
    documents: [child('LOST-1', 'unknown-space')],
    statusEvents: [child('SLUG-1', 'by-slug')],
  }
  const result = selectTaskPushRows(
    input,
    [
      { name: 'defaulted', settings: {} },
      { name: 'by-slug', settings: { space: 'active' } },
      { name: 'by-id', settings: { space: 'space-a' } },
      { name: 'other', settings: { space: 'other' } },
      { name: 'unknown-space', settings: { space: 'missing' } },
    ],
    {
      activeSpaceId: 'space-a',
      memberships: [
        { spaceId: 'space-a', slug: 'active' },
        { spaceId: 'space-b', slug: 'other' },
      ],
    },
  )

  expect(result.rows.tasks.map((row) => row.key)).toEqual(['DEF-1', 'SLUG-1', 'ID-1'])
  expect(result.rows.statusEvents).toHaveLength(1)
  expect(result.skipped).toEqual([
    {
      project: 'other',
      reason: 'different-space',
      tasks: 1,
      comments: 1,
      documents: 0,
      statusEvents: 0,
    },
    {
      project: 'unknown-space',
      reason: 'unmapped',
      tasks: 1,
      comments: 0,
      documents: 1,
      statusEvents: 0,
    },
    {
      project: 'unregistered',
      reason: 'unmapped',
      tasks: 1,
      comments: 0,
      documents: 0,
      statusEvents: 0,
    },
  ])
})

test('task push persists generated record ids and a dry run leaves them unassigned', async () => {
  const at = '2026-09-24T12:00:00.000Z'
  writeTransaction((conn) => {
    conn
      .query(`INSERT INTO task(key,project,title,status,status_category,source,first_seen,last_seen)
        VALUES ('LOC-885','workshop','Push ids','open','open','local',?,?)`)
      .run(at, at)
    conn
      .query(`INSERT INTO task_comment(task_key,body,created_at) VALUES ('LOC-885','body',?)`)
      .run(at)
    conn
      .query(`INSERT INTO task_document(task_key,title,body,version,created_at,updated_at)
        VALUES ('LOC-885','title','body','v1',?,?)`)
      .run(at, at)
    conn
      .query(`INSERT INTO task_status_event(task_key,at,from_status,to_status)
        VALUES ('LOC-885',?,NULL,'open')`)
      .run(at)
  })
  const mirrorBodies: Record<string, unknown>[] = []
  const stub = async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname
    if (path === '/v1/tasks/identity')
      return Response.json({ activeSpaceId: 'space-a', memberships: [] })
    if (path === '/v1/tasks/mirror') {
      mirrorBodies.push(JSON.parse(String(init?.body)))
      return Response.json({ upserted: 1 })
    }
    if (path === '/v1/tasks/counts') return Response.json({})
    return Response.json({ error: 'unexpected request' }, { status: 500 })
  }
  const options = { baseUrl: 'https://hub.example.test', token: 'test', fetch: stub }

  const dryRun = await pushTasks({ ...options, dryRun: true })
  expect(dryRun.assignedRecordIds).toBe(4)
  for (const table of ['task', 'task_comment', 'task_document', 'task_status_event'])
    expect(
      db().query<{ record_id: string | null }, []>(`SELECT record_id FROM ${table}`).get()
        ?.record_id,
    ).toBeNull()

  await pushTasks(options)
  const firstIds = mirrorBodies
    .flatMap((body) =>
      ['tasks', 'comments', 'documents', 'statusEvents'].flatMap((name) => body[name] ?? []),
    )
    .map((row) => (row as { id: string }).id)
  mirrorBodies.length = 0
  await pushTasks(options)
  const secondIds = mirrorBodies
    .flatMap((body) =>
      ['tasks', 'comments', 'documents', 'statusEvents'].flatMap((name) => body[name] ?? []),
    )
    .map((row) => (row as { id: string }).id)

  expect(firstIds).toHaveLength(4)
  expect(secondIds).toEqual(firstIds)
  for (const table of ['task', 'task_comment', 'task_document', 'task_status_event'])
    expect(
      db().query<{ record_id: string | null }, []>(`SELECT record_id FROM ${table}`).get()
        ?.record_id,
    ).toBeString()
})
