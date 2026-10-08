import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { pushTasks } from './task-push.ts'
import { planTaskPush } from './task-push-plan.ts'

beforeEach(resetFixtureStore)

test('task push groups projects and children by destination and reports refusals', () => {
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
  const result = planTaskPush(
    input,
    [
      { name: 'defaulted', settings: {} },
      { name: 'by-slug', settings: { space: 'active' } },
      { name: 'by-id', settings: { space: 'space-a' } },
      { name: 'other', settings: { space: 'other' } },
      { name: 'unknown-space', settings: { space: 'missing' } },
    ],
    {
      userId: 'user-a',
      activeSpaceId: 'space-a',
      memberships: [
        { spaceId: 'space-a', slug: 'active' },
        { spaceId: 'space-b', slug: 'other' },
      ],
    },
  )

  expect(
    result.destinations.map((destination) => ({
      spaceId: destination.spaceId,
      tasks: destination.rows.tasks.map((row) => row.key),
      comments: destination.rows.comments.map((row) => row.task_key),
      statusEvents: destination.rows.statusEvents.map((row) => row.task_key),
    })),
  ).toEqual([
    {
      spaceId: 'space-a',
      tasks: ['DEF-1', 'SLUG-1', 'ID-1'],
      comments: [],
      statusEvents: ['SLUG-1'],
    },
    { spaceId: 'space-b', tasks: ['OTHER-1'], comments: ['OTHER-1'], statusEvents: [] },
  ])
  expect(result.refused).toEqual([
    {
      project: 'unknown-space',
      reason: 'declared-space-not-member',
      tasks: 1,
      comments: 0,
      documents: 1,
      statusEvents: 0,
    },
    {
      project: 'unregistered',
      reason: 'unregistered-project',
      tasks: 1,
      comments: 0,
      documents: 0,
      statusEvents: 0,
    },
  ])
})

test('task push persists ids only after each successful batch and retries an unpersisted batch', async () => {
  const at = '2026-09-24T12:00:00.000Z'
  writeTransaction((conn) => {
    conn
      .query(`INSERT INTO task(record_id,key,project,title,status,status_category,source,first_seen,last_seen)
        VALUES ('01990000-0000-7000-8000-000000000001','LOC-885','workshop','Push ids','open','open','local',?,?)`)
      .run(at, at)
    const insert = conn.query(
      `INSERT INTO task_status_event(task_key,task_record_id,at,from_status,to_status)
       VALUES ('LOC-885','01990000-0000-7000-8000-000000000001',?,NULL,'open')`,
    )
    for (let index = 0; index < 501; index++)
      insert.run(new Date(Date.parse(at) + index).toISOString())
  })
  const holderId = '01990000-0000-7000-8000-000000000099'
  let statusBatch = 0
  let failSecondBatch = true
  const stub = async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname
    if (path === '/v1/tasks/identity')
      return Response.json({ userId: 'user-a', activeSpaceId: 'space-a', memberships: [] })
    if (path === '/v1/tasks/mirror') {
      const body = JSON.parse(String(init?.body)) as {
        targetSpaceId?: string
        statusEvents?: Array<{
          id: string
          legacy_local_id: number
          newly_assigned: boolean
          task_id: string | null
          task_record_id?: string
        }>
      }
      expect(body.targetSpaceId).toBe('space-a')
      const events = body.statusEvents ?? []
      if (!events.length) return Response.json({ upserted: 0, adoptions: [] })
      statusBatch++
      if (failSecondBatch && statusBatch === 2)
        return Response.json({ error: 'simulated second batch failure' }, { status: 409 })
      const last = events.find((event) => event.legacy_local_id === 501)
      if (!last) return Response.json({ upserted: events.length, adoptions: [] })
      if (!last.newly_assigned)
        return Response.json(
          { error: 'existing holder refused a persisted fresh id' },
          { status: 409 },
        )
      return Response.json({
        upserted: events.length,
        adoptions: [
          {
            table: 'task_status_event',
            legacy_local_id: last.legacy_local_id,
            id: holderId,
          },
        ],
      })
    }
    if (path === '/v1/tasks/counts') return Response.json({})
    return Response.json({ error: 'unexpected request' }, { status: 500 })
  }
  const options = { baseUrl: 'https://hub.example.test', token: 'test', fetch: stub }

  const dryRun = await pushTasks({ ...options, dryRun: true })
  expect(dryRun.assignedRecordIds).toBe(501)
  expect(
    db()
      .query<{ count: number }, []>(
        `SELECT count(*) count FROM task_status_event WHERE record_id IS NOT NULL`,
      )
      .get()?.count,
  ).toBe(0)

  const refused = await pushTasks(options)
  expect(refused.skipped[0]?.reason).toContain('simulated second batch failure')
  expect(
    db()
      .query<{ count: number }, []>(
        `SELECT count(*) count FROM task_status_event WHERE record_id IS NOT NULL`,
      )
      .get()?.count,
  ).toBe(500)

  failSecondBatch = false
  statusBatch = 0
  await pushTasks(options)

  expect(
    db()
      .query<{ count: number }, []>(
        `SELECT count(*) count FROM task_status_event WHERE record_id IS NOT NULL`,
      )
      .get()?.count,
  ).toBe(501)
  expect(
    db()
      .query<{ record_id: string }, []>(`SELECT record_id FROM task_status_event WHERE id=501`)
      .get()?.record_id,
  ).toBe(holderId)
})

test('task push adopts a hosted holder id and uses it on the next push', async () => {
  const at = '2026-09-24T12:00:00.000Z'
  writeTransaction((conn) => {
    conn
      .query(
        `INSERT INTO task(record_id,key,project,title,status,status_category,source,first_seen,last_seen)
        VALUES ('01990000-0000-7000-8000-000000000001','LOC-886','workshop','Adopt id','open','open','local',?,?)`,
      )
      .run(at, at)
    conn
      .query(
        `INSERT INTO task_status_event(task_key,task_record_id,at,from_status,to_status)
        VALUES ('LOC-886','01990000-0000-7000-8000-000000000001',?,NULL,'open')`,
      )
      .run(at)
  })
  const holderId = '01990000-0000-7000-8000-000000000099'
  const sentEvents: Array<{
    id: string
    legacy_local_id: number
    newly_assigned: boolean
    task_id: string | null
    task_record_id?: string
  }> = []
  let adopted = false
  const stub = async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname
    if (path === '/v1/tasks/identity')
      return Response.json({ userId: 'user-a', activeSpaceId: 'space-a', memberships: [] })
    if (path === '/v1/tasks/mirror') {
      const body = JSON.parse(String(init?.body)) as {
        statusEvents?: Array<{
          id: string
          legacy_local_id: number
          newly_assigned: boolean
          task_id: string | null
          task_record_id?: string
        }>
      }
      const event = body.statusEvents?.[0]
      if (!event) return Response.json({ upserted: 0, adoptions: [] })
      sentEvents.push(event)
      if (!adopted) {
        adopted = true
        return Response.json({
          upserted: 1,
          adoptions: [
            {
              table: 'task_status_event',
              legacy_local_id: event.legacy_local_id,
              id: holderId,
            },
          ],
        })
      }
      return Response.json({ upserted: 1, adoptions: [] })
    }
    if (path === '/v1/tasks/counts') return Response.json({})
    return Response.json({ error: 'unexpected request' }, { status: 500 })
  }
  const options = {
    baseUrl: 'https://hub.example.test',
    token: 'test',
    fetch: stub,
  }

  await pushTasks(options)
  expect(
    db().query<{ record_id: string }, []>(`SELECT record_id FROM task_status_event`).get()
      ?.record_id,
  ).toBe(holderId)
  await pushTasks(options)

  expect(sentEvents).toHaveLength(2)
  expect(sentEvents[0]).toMatchObject({
    newly_assigned: true,
    task_id: '01990000-0000-7000-8000-000000000001',
  })
  expect(sentEvents[0]).not.toHaveProperty('task_record_id')
  expect(sentEvents[1]).toMatchObject({ id: holderId, newly_assigned: false })
})

test('task push persists a task adoption and cascades its child identity', async () => {
  const at = '2026-09-24T12:00:00.000Z'
  const incomingId = '01990000-0000-7000-8000-000000000001'
  const holderId = '01990000-0000-7000-8000-000000000099'
  writeTransaction((conn) => {
    conn
      .query(
        `INSERT INTO task(record_id,key,project,title,status,status_category,source,first_seen,last_seen)
         VALUES (?,'LOC-887','workshop','Adopt task','open','open','local',?,?)`,
      )
      .run(incomingId, at, at)
    conn
      .query(
        `INSERT INTO task_comment(task_key,task_record_id,body,created_at)
         VALUES ('LOC-887',?,'child',?)`,
      )
      .run(incomingId, at)
  })
  const stub = async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname
    if (path === '/v1/tasks/identity')
      return Response.json({ userId: 'user-a', activeSpaceId: 'space-a', memberships: [] })
    if (path === '/v1/tasks/mirror') {
      const body = JSON.parse(String(init?.body)) as { tasks?: Array<{ key: string }> }
      const task = body.tasks?.[0]
      return Response.json({
        upserted: task ? 1 : 0,
        adoptions: task
          ? [{ table: 'task', project: 'workshop', key: task.key, id: holderId }]
          : [],
      })
    }
    if (path === '/v1/tasks/counts') return Response.json({})
    return Response.json({ error: 'unexpected request' }, { status: 500 })
  }

  await pushTasks({ baseUrl: 'https://hub.example.test', token: 'test', fetch: stub })

  expect(db().query<{ record_id: string }, []>(`SELECT record_id FROM task`).get()?.record_id).toBe(
    holderId,
  )
  expect(
    db().query<{ task_record_id: string }, []>(`SELECT task_record_id FROM task_comment`).get()
      ?.task_record_id,
  ).toBe(holderId)
})
