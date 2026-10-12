import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { RECORD_ACTOR_ROLE } from '../../shared/record/schema.ts'
import { bindTenant } from '../../shared/record/tenant.ts'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { db, writeTransaction } from './db.ts'
import { applyHostedPushChangesInTransaction } from './hosted-push-changes.ts'
import { mirrorHostedTaskBody } from './hosted-tasks.ts'
import { upsertGitTasks } from './ingest/git-task-cache.ts'
import { applyMigrations } from './migrations.ts'
import { drainHostedOutbox } from './outbox.ts'
import { loadOutboxChange } from './outbox-row.ts'
import {
  type HostedPushChange,
  type PushedStatusEvent,
  type PushedTask,
  parseHostedPushItem,
} from './push-contract.ts'
import { closeTask, commentTask, setTask } from './task.ts'
import type { HostedTaskIdentity } from './task-client.ts'
import { deleteTaskDocument, updateTaskDocument } from './task-document.ts'

const spaceId = '01990000-0000-7000-8000-000000001250'
const taskId = '01990000-0000-7000-8000-000000001251'
const userId = '01990000-0000-7000-8000-000000001249'
const identity = { userId, spaceId }
let database: PGlite

const row = (id: string, at: string, task = taskId): PushedStatusEvent => ({
  id,
  task_key: task === taskId ? 'DEV-1' : 'DEV-404',
  task_id: task,
  project_name: 'workshop',
  at,
  from_status: 'open',
  to_status: 'active',
  created_at: at,
  updated_at: at,
  deleted_at: null,
})

const taskRow = (id: string, key: string, source: PushedTask['source'] = 'git'): PushedTask => ({
  id,
  key,
  project: 'workshop',
  project_name: 'workshop',
  title: source === 'git' ? null : key,
  status: source === 'git' ? null : 'active',
  status_category: source === 'git' ? null : 'active',
  parent_key: null,
  parent_id: null,
  body: null,
  assignee: null,
  opened_at: '2026-10-09T10:00:00.000Z',
  closed_at: null,
  source,
  first_seen: '2026-10-09T10:00:00.000Z',
  last_seen: '2026-10-09T11:00:00.000Z',
  created_at: '2026-10-09T10:00:00.000Z',
  updated_at: '2026-10-09T11:00:00.000Z',
  deleted_at: null,
  next_document_number: 1,
})

const apply = (inputs: HostedPushChange[], selectedIdentity = identity) =>
  database.transaction(async (transaction) => {
    const sql = pgliteSql(transaction as unknown as PGlite)
    sql.unsafe = (async (statement: string) =>
      (await transaction.query(statement)).rows) as SQL['unsafe']
    return applyHostedPushChangesInTransaction(sql, selectedIdentity, inputs)
  })

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
  await mirrorHostedTaskBody(
    pgliteSql(database),
    identity,
    {
      tasks: [
        {
          id: taskId,
          key: 'DEV-1',
          project: 'workshop',
          project_name: 'workshop',
          title: 'First',
          status: 'active',
          status_category: 'active',
          parent_key: null,
          body: null,
          assignee: null,
          opened_at: '2026-10-09T10:00:00.000Z',
          closed_at: null,
          source: 'mcp',
          first_seen: '2026-10-09T10:00:00.000Z',
          last_seen: '2026-10-09T11:00:00.000Z',
          created_at: '2026-10-09T10:00:00.000Z',
          updated_at: '2026-10-09T11:00:00.000Z',
          deleted_at: null,
          next_document_number: 1,
        },
      ],
    },
    1,
  )
})

afterAll(async () => {
  if (database) await database.close()
})

test('isolates one rejected status event while committing applied and duplicate rows', async () => {
  const eventId = '01990000-0000-7000-8000-000000001260'
  const collisionId = '01990000-0000-7000-8000-000000001261'
  const laterId = '01990000-0000-7000-8000-000000001262'
  const first = row(eventId, '2026-10-09T13:00:00.000Z')
  expect(
    await apply([{ table: 'hub_task_status_event', id: eventId, op: 'upsert', row: first }]),
  ).toEqual([{ id: eventId, status: 'applied' }])
  expect(
    await apply([
      { table: 'hub_task_status_event', id: eventId, op: 'upsert', row: first },
      {
        table: 'hub_task_status_event',
        id: collisionId,
        op: 'upsert',
        row: row(collisionId, '2026-10-09T13:00:00.000Z'),
      },
      {
        table: 'hub_task_status_event',
        id: laterId,
        op: 'upsert',
        row: row(laterId, '2026-10-09T14:00:00.000Z'),
      },
    ]),
  ).toEqual([
    { id: eventId, status: 'duplicate' },
    { id: collisionId, status: 'rejected', reason: expect.stringContaining('already belongs') },
    { id: laterId, status: 'applied' },
  ])
  expect(
    (
      await database.query<{ id: string }>(
        `SELECT id::text FROM hub_task_status_event WHERE id=ANY($1::uuid[]) ORDER BY id`,
        [[eventId, collisionId, laterId]],
      )
    ).rows,
  ).toEqual([{ id: eventId }, { id: laterId }])
  expect(
    await apply([
      {
        table: 'hub_task_status_event',
        id: eventId,
        op: 'upsert',
        row: { ...first, to_status: 'review' },
      },
    ]),
  ).toEqual([{ id: eventId, status: 'rejected', reason: expect.stringContaining('differs') }])
})

test('keeps a pushed status event idempotent while its task is absent', async () => {
  const event = row(
    '01990000-0000-7000-8000-000000001269',
    '2026-10-09T15:00:00.000Z',
    '01990000-0000-7000-8000-000000009999',
  )
  const input: HostedPushChange = {
    table: 'hub_task_status_event',
    id: event.id,
    op: 'upsert',
    row: event,
  }
  expect(await apply([input])).toEqual([{ id: event.id, status: 'applied' }])
  expect(await apply([input])).toEqual([{ id: event.id, status: 'duplicate' }])
  expect(
    (await database.query(`SELECT task_id FROM hub_task_status_event WHERE id=$1`, [event.id]))
      .rows,
  ).toEqual([{ task_id: null }])
})

test('applies and deduplicates tasks while isolating collisions and source refusals', async () => {
  const insertedId = '01990000-0000-7000-8000-000000001280'
  const laterId = '01990000-0000-7000-8000-000000001281'
  const adoptFromId = '01990000-0000-7000-8000-000000001282'
  const collisionId = '01990000-0000-7000-8000-000000001283'
  const inserted = taskRow(insertedId, 'DEV-80')
  expect(await apply([{ table: 'hub_task', id: insertedId, op: 'upsert', row: inserted }])).toEqual(
    [{ id: insertedId, status: 'applied' }],
  )
  expect(await apply([{ table: 'hub_task', id: insertedId, op: 'upsert', row: inserted }])).toEqual(
    [{ id: insertedId, status: 'duplicate' }],
  )
  expect(
    await apply([
      {
        table: 'hub_task',
        id: adoptFromId,
        op: 'upsert',
        row: { ...taskRow(adoptFromId, 'DEV-1', 'mcp'), title: 'First' },
      },
    ]),
  ).toEqual([{ id: adoptFromId, status: 'applied', adoptedId: taskId }])

  const outcomes = await apply([
    {
      table: 'hub_task',
      id: collisionId,
      op: 'upsert',
      row: taskRow(collisionId, 'DEV-80', 'local'),
    },
    { table: 'hub_task', id: taskId, op: 'upsert', row: taskRow(taskId, 'DEV-1') },
    { table: 'hub_task', id: laterId, op: 'upsert', row: taskRow(laterId, 'DEV-82') },
  ])
  expect(outcomes).toEqual([
    { id: collisionId, status: 'rejected', reason: expect.stringContaining('already belongs') },
    { id: taskId, status: 'rejected', reason: expect.stringContaining('from git over hosted mcp') },
    { id: laterId, status: 'applied' },
  ])
  expect((await database.query(`SELECT key FROM hub_task WHERE id=$1`, [laterId])).rows).toEqual([
    { key: 'DEV-82' },
  ])
})

test('a production-shaped git task date crosses the edge and remains idempotent', async () => {
  const machine = new Database(':memory:')
  applyMigrations(machine)
  upsertGitTasks(
    machine,
    [{ key: 'DEV-84', project: 'workshop', first: '2026-10-09', last: '2026-10-09' }],
    '2026-10-09T11:00:00.000Z',
  )
  const id = machine
    .query<{ record_id: string }, []>(`SELECT record_id FROM task WHERE key='DEV-84'`)
    .get()!.record_id
  const pointer = machine
    .query<{ table_name: string; row_id: string; operation: 'upsert' | 'delete' }, []>(
      `SELECT table_name,row_id,operation FROM hosted_outbox`,
    )
    .get()!
  const input = loadOutboxChange(machine, pointer)!.change
  machine.close()
  expect(input.table).toBe('hub_task')
  if (input.table !== 'hub_task' || input.op !== 'upsert') throw new Error('expected task upsert')
  expect(input.row.opened_at).toBe('2026-10-09T00:00:00.000Z')
  expect(input.row.updated_at).toBe('2026-10-09T00:00:00.000Z')
  expect(parseHostedPushItem(input)).toEqual({ input })
  expect(await apply([input])).toEqual([{ id, status: 'applied' }])
  expect(await apply([input])).toEqual([{ id, status: 'duplicate' }])
})

test('later git observations cannot send cached tracker or local rows', async () => {
  const localId = '01990000-0000-7000-8000-000000001285'
  const hostedLocal = {
    ...taskRow(localId, 'DEV-85', 'local'),
    title: 'Newer local title',
    status: 'review',
    status_category: 'review' as const,
    body: 'Newer local body',
  }
  expect(await apply([{ table: 'hub_task', id: localId, op: 'upsert', row: hostedLocal }])).toEqual(
    [{ id: localId, status: 'applied' }],
  )

  const machine = new Database(':memory:')
  applyMigrations(machine)
  const insert = machine.query(
    `INSERT INTO task
      (record_id,key,project,title,status,status_category,body,source,first_seen,last_seen,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  )
  insert.run(
    taskId,
    'DEV-1',
    'workshop',
    'Stale tracker title',
    'open',
    'open',
    'Stale tracker body',
    'mcp',
    '2026-10-01T00:00:00.000Z',
    '2026-10-02T00:00:00.000Z',
    '2026-10-02T00:00:00.000Z',
  )
  insert.run(
    localId,
    'DEV-85',
    'workshop',
    'Stale local title',
    'open',
    'open',
    'Stale local body',
    'local',
    '2026-10-01T00:00:00.000Z',
    '2026-10-02T00:00:00.000Z',
    '2026-10-02T00:00:00.000Z',
  )
  upsertGitTasks(
    machine,
    [
      { key: 'DEV-1', project: 'workshop', first: '2026-10-01', last: '2026-10-03' },
      { key: 'DEV-85', project: 'workshop', first: '2026-10-01', last: '2026-10-03' },
    ],
    '2026-10-11T12:00:00.000Z',
  )
  expect(machine.query(`SELECT 1 FROM hosted_outbox`).all()).toHaveLength(0)
  machine.close()

  expect(
    (
      await database.query(
        `SELECT key,title,status,body FROM hub_task WHERE id=ANY($1::uuid[]) ORDER BY key`,
        [[taskId, localId]],
      )
    ).rows,
  ).toEqual([
    { key: 'DEV-1', title: 'First', status: 'active', body: null },
    {
      key: 'DEV-85',
      title: 'Newer local title',
      status: 'review',
      body: 'Newer local body',
    },
  ])
})

test('real policies reject a push into a space without write membership', async () => {
  const refusedSpace = '01990000-0000-7000-8000-000000001270'
  const eventId = '01990000-0000-7000-8000-000000001271'
  await database.exec(`
    RESET ROLE;
    INSERT INTO space(id,name,slug,created_at)
    VALUES ('${refusedSpace}','Refused push','refused-push',now());
    SET ROLE ${RECORD_ACTOR_ROLE};
  `)
  const outcomes = await database.transaction(async (transaction) => {
    const sql = pgliteSql(transaction as unknown as PGlite)
    sql.unsafe = (async (statement: string) =>
      (await transaction.query(statement)).rows) as SQL['unsafe']
    await bindTenant(sql, { userId, spaceId: refusedSpace, spaceIds: [spaceId] })
    const event = { ...row(eventId, '2026-10-09T15:00:00.000Z'), task_id: null }
    return applyHostedPushChangesInTransaction(sql, { userId, spaceId: refusedSpace }, [
      {
        table: 'hub_task_status_event',
        id: eventId,
        op: 'upsert',
        row: event,
      },
    ])
  })
  expect(outcomes).toEqual([
    { id: eventId, status: 'rejected', reason: expect.stringContaining('row-level security') },
  ])
  expect(
    (await database.query(`SELECT 1 FROM hub_task_status_event WHERE id=$1`, [eventId])).rows,
  ).toHaveLength(0)
})

test('field task pushes preserve other hosted edits, deduplicate, and create an absent whole row', async () => {
  const hostedEdit = {
    ...taskRow(taskId, 'DEV-1', 'mcp'),
    title: 'Other writer title',
    status: 'review',
    status_category: 'review' as const,
    updated_at: '2026-10-11T13:00:00.000Z',
    last_seen: '2026-10-11T13:00:00.000Z',
  }
  expect(await apply([{ table: 'hub_task', id: taskId, op: 'upsert', row: hostedEdit }])).toEqual([
    { id: taskId, status: 'applied' },
  ])
  const offlineStatus = {
    ...hostedEdit,
    title: 'Stale machine title',
    status: 'done',
    status_category: 'done' as const,
    closed_at: '2026-10-11T14:00:00.000Z',
    updated_at: '2026-10-11T14:00:00.000Z',
    last_seen: '2026-10-11T14:00:00.000Z',
  }
  const change: HostedPushChange = {
    table: 'hub_task',
    id: taskId,
    op: 'upsert',
    row: offlineStatus,
    fields: ['status', 'status_category'],
  }
  expect(await apply([change])).toEqual([{ id: taskId, status: 'applied' }])
  expect(await apply([change])).toEqual([{ id: taskId, status: 'duplicate' }])
  expect(
    (await database.query(`SELECT title,status FROM hub_task WHERE id=$1`, [taskId])).rows,
  ).toEqual([{ title: 'Other writer title', status: 'done' }])

  const repeatedDone = {
    ...offlineStatus,
    closed_at: '2026-10-11T15:00:00.000Z',
    updated_at: '2026-10-11T15:00:00.000Z',
    last_seen: '2026-10-11T15:00:00.000Z',
  }
  const repeatedDoneChange: HostedPushChange = { ...change, row: repeatedDone }
  expect(await apply([repeatedDoneChange])).toEqual([{ id: taskId, status: 'applied' }])
  expect(await apply([repeatedDoneChange])).toEqual([{ id: taskId, status: 'duplicate' }])
  expect(
    (await database.query(`SELECT closed_at::text FROM hub_task WHERE id=$1`, [taskId])).rows,
  ).toEqual([{ closed_at: '2026-10-11 14:00:00+00' }])

  const laterTitle: HostedPushChange = {
    table: 'hub_task',
    id: taskId,
    op: 'upsert',
    row: { ...repeatedDone, title: 'Later arriving title' },
    fields: ['title'],
  }
  expect(await apply([laterTitle])).toEqual([{ id: taskId, status: 'applied' }])
  expect((await database.query(`SELECT title FROM hub_task WHERE id=$1`, [taskId])).rows).toEqual([
    { title: 'Later arriving title' },
  ])

  const absentId = '01990000-0000-7000-8000-000000001299'
  const absent = { ...taskRow(absentId, 'DEV-99', 'local'), title: 'Whole insert', body: 'kept' }
  expect(
    await apply([
      { table: 'hub_task', id: absentId, op: 'upsert', row: absent, fields: ['title'] },
    ]),
  ).toEqual([{ id: absentId, status: 'applied' }])
  expect(
    (await database.query(`SELECT title,body FROM hub_task WHERE id=$1`, [absentId])).rows,
  ).toEqual([{ title: 'Whole insert', body: 'kept' }])
})

test('offline commands later drain through the real outbox into hosted task rows', async () => {
  const machineTaskId = '01990000-0000-7000-8000-000000001320'
  const documentId = '01990000-0000-7000-8000-000000001321'
  const at = '2026-10-11T16:00:00.000Z'
  const unavailable = {
    baseUrl: 'https://unreachable.example.test',
    token: 'test',
    fetch: async () => {
      throw new Error('hosted hub unavailable')
    },
  }
  writeTransaction((conn) => {
    conn
      .query(
        `INSERT INTO task
        (record_id,key,project,title,status,status_category,source,first_seen,last_seen,updated_at)
        VALUES (?,'GAM-320','gamma','Before','open','open','local',?,?,?)`,
      )
      .run(machineTaskId, at, at, at)
    conn
      .query(
        `INSERT INTO task_document
        (record_id,task_key,task_record_id,number,title,body,version,created_at,updated_at)
        VALUES (?,'GAM-320',?,1,'Before','body','v1',?,?)`,
      )
      .run(documentId, machineTaskId, at, at)
  })
  expect(
    await apply([
      {
        table: 'hub_task',
        id: machineTaskId,
        op: 'upsert',
        row: {
          ...taskRow(machineTaskId, 'GAM-320', 'local'),
          project: 'gamma',
          project_name: 'gamma',
        },
      },
      {
        table: 'hub_task_document',
        id: documentId,
        op: 'upsert',
        row: {
          id: documentId,
          task_key: 'GAM-320',
          task_id: machineTaskId,
          project_name: 'gamma',
          number: 1,
          role: null,
          title: 'Before',
          body: 'body',
          version: 'v1',
          created_at: at,
          updated_at: at,
          deleted_at: null,
        },
      },
    ]),
  ).toEqual([
    { id: machineTaskId, status: 'applied' },
    { id: documentId, status: 'applied' },
  ])

  const registered = () => [{ name: 'gamma', settings: { keyPrefixes: ['GAM'], space: spaceId } }]
  const hostedIdentity = async (): Promise<HostedTaskIdentity> => ({
    userId,
    activeSpaceId: spaceId,
    memberships: [{ spaceId, slug: 'gamma', permission: 'write' as const }],
    capabilities: {
      spacePush: true,
      spacePushTables: [
        'hub_task',
        'hub_task_comment',
        'hub_task_document',
        'hub_task_status_event',
      ],
    },
  })
  const sent: HostedPushChange[] = []
  const drain = () =>
    drainHostedOutbox({
      identity: hostedIdentity,
      registered,
      push: async (changes) => {
        sent.push(...changes)
        return apply(changes)
      },
    })

  await setTask(
    'GAM-320',
    { recordId: machineTaskId },
    { title: 'Offline title' },
    { hosted: unavailable },
  )
  expect((await drain()).sent).toBe(1)
  expect(
    (await database.query(`SELECT title FROM hub_task WHERE id=$1`, [machineTaskId])).rows,
  ).toEqual([{ title: 'Offline title' }])

  await commentTask('GAM-320', { recordId: machineTaskId }, 'Offline comment', {
    hosted: unavailable,
  })
  expect((await drain()).sent).toBe(1)
  expect(
    (await database.query(`SELECT body FROM hub_task_comment WHERE task_id=$1`, [machineTaskId]))
      .rows,
  ).toEqual([{ body: 'Offline comment' }])

  await updateTaskDocument(documentId, { title: 'Offline document' }, { hosted: unavailable })
  expect((await drain()).sent).toBe(1)
  expect(
    (await database.query(`SELECT title FROM hub_task_document WHERE id=$1`, [documentId])).rows,
  ).toEqual([{ title: 'Offline document' }])

  await closeTask(
    'GAM-320',
    { recordId: machineTaskId },
    {
      hosted: unavailable,
      classify: async () => ({
        project: 'gamma',
        key: 'GAM-320',
        dryRun: true,
        deleted: [],
        kept: [],
        operator: [],
        wouldDelete: [],
        errors: [],
      }),
    },
  )
  expect((await drain()).sent).toBe(2)
  const statusEvent = sent.find((change) => change.table === 'hub_task_status_event')
  if (!statusEvent) throw new Error('expected a drained status event')
  expect(await apply([statusEvent])).toEqual([{ id: statusEvent.id, status: 'duplicate' }])

  await deleteTaskDocument(documentId, { hosted: unavailable })
  expect((await drain()).sent).toBe(1)
  expect(
    (
      await database.query(
        `SELECT deleted_at IS NOT NULL AS deleted FROM hub_task_document WHERE id=$1`,
        [documentId],
      )
    ).rows,
  ).toEqual([{ deleted: true }])
  expect(db().query(`SELECT 1 FROM hosted_outbox`).all()).toHaveLength(0)
})

test('comment and document pushes apply their route effects and deduplicate deletes', async () => {
  const commentId = '01990000-0000-7000-8000-000000001301'
  const at = '2026-10-11T15:00:00.000Z'
  const comment: HostedPushChange = {
    table: 'hub_task_comment',
    id: commentId,
    op: 'upsert',
    row: {
      id: commentId,
      task_key: 'DEV-1',
      task_id: taskId,
      project_name: 'workshop',
      body: 'offline',
      created_at: at,
      updated_at: at,
      deleted_at: null,
    },
  }
  expect(await apply([comment])).toEqual([{ id: commentId, status: 'applied' }])
  expect(await apply([comment])).toEqual([{ id: commentId, status: 'duplicate' }])
  expect(
    (await database.query(`SELECT body FROM hub_task_comment WHERE id=$1`, [commentId])).rows,
  ).toEqual([{ body: 'offline' }])

  const documentId = '01990000-0000-7000-8000-000000001302'
  const document: HostedPushChange = {
    table: 'hub_task_document',
    id: documentId,
    op: 'upsert',
    row: {
      id: documentId,
      task_key: 'DEV-1',
      task_id: taskId,
      project_name: 'workshop',
      number: 1,
      role: null,
      title: 'offline',
      body: 'body',
      version: 'v1',
      created_at: at,
      updated_at: at,
      deleted_at: null,
    },
  }
  expect(await apply([document])).toEqual([{ id: documentId, status: 'applied' }])
  expect(await apply([document])).toEqual([{ id: documentId, status: 'duplicate' }])
  expect(await apply([{ table: 'hub_task_document', id: documentId, op: 'delete' }])).toEqual([
    { id: documentId, status: 'applied' },
  ])
  expect(await apply([{ table: 'hub_task_document', id: documentId, op: 'delete' }])).toEqual([
    { id: documentId, status: 'duplicate' },
  ])
})
