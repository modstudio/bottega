import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { pullHostedTaskChanges } from './hosted-change-cache.ts'
import { applyHostedPushChangesInTransaction } from './hosted-push-changes.ts'
import { HOSTED_CHANGES_CURSOR_KEY } from './hosted-task-change-family.ts'
import { applyMigrations } from './migrations.ts'
import { drainHostedOutbox, queueHostedChange, runHostedOutboxCommand } from './outbox.ts'
import { loadOutboxChange } from './outbox-row.ts'
import {
  HOSTED_STATUS_EVENT_TABLE,
  type HostedPushChange,
  type PushedStatusEvent,
  type PushedTask,
} from './push-contract.ts'
import type { HostedTaskIdentity } from './task-client.ts'

const spaceId = '01990000-0000-7000-8000-000000001400'
const taskId = '01990000-0000-7000-8000-000000001401'
const userId = '01990000-0000-7000-8000-000000001399'
const identity = { userId, spaceId }
let database: PGlite

const taskRow = (): PushedTask => ({
  id: taskId,
  key: 'DEV-1',
  project: 'workshop',
  project_name: 'workshop',
  title: 'First',
  status: 'active',
  status_category: 'active',
  parent_key: null,
  parent_id: null,
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
})

const eventRow = (id: string, at: string): PushedStatusEvent => ({
  id,
  task_key: 'DEV-1',
  task_id: taskId,
  project_name: 'workshop',
  at,
  from_status: 'open',
  to_status: 'active',
  created_at: at,
  updated_at: at,
  deleted_at: null,
})

const apply = (inputs: HostedPushChange[]) =>
  database.transaction(async (transaction) => {
    const sql = pgliteSql(transaction as unknown as PGlite)
    sql.unsafe = (async (statement: string) =>
      (await transaction.query(statement)).rows) as SQL['unsafe']
    return applyHostedPushChangesInTransaction(sql, identity, inputs)
  })

const registered = () => [
  { name: 'workshop', settings: { keyPrefixes: ['DEV'], space: spaceId } },
]

const pushIdentity = async (): Promise<HostedTaskIdentity> => ({
  userId,
  activeSpaceId: spaceId,
  memberships: [{ spaceId, slug: 'workshop', permission: 'write' as const }],
  capabilities: {
    spacePush: true,
    spaceChanges: true,
    spacePushTables: ['hub_task', HOSTED_STATUS_EVENT_TABLE],
  },
})

function insertTaskAndEvent(conn: Database, eventId: string, at: string) {
  conn
    .query(
      `INSERT INTO task (record_id,key,project,title,status,status_category,source,first_seen,last_seen)
       VALUES (?,'DEV-1','workshop','First','active','active','mcp',?,?)`,
    )
    .run(taskId, at, at)
  conn
    .query(
      `INSERT INTO task_status_event (record_id,task_key,task_record_id,at,from_status,to_status)
       VALUES (?,'DEV-1',?,?,?,?)`,
    )
    .run(eventId, taskId, at, 'open', 'active')
  queueHostedChange(conn, HOSTED_STATUS_EVENT_TABLE, eventId, 'upsert', at)
}

function mintOn(conn: Database, eventId: string, at: string): HostedPushChange {
  insertTaskAndEvent(conn, eventId, at)
  const loaded = loadOutboxChange(conn, {
    table_name: HOSTED_STATUS_EVENT_TABLE,
    row_id: eventId,
    operation: 'upsert',
  })
  if (!loaded || loaded.change.table !== HOSTED_STATUS_EVENT_TABLE)
    throw new Error('expected a status event outbox change')
  return loaded.change
}

function drainToHosted() {
  return drainHostedOutbox({
    identity: pushIdentity,
    registered,
    push: async (changes) => apply(changes),
  })
}

function hostedEventIds() {
  return database.query<{ id: string }>(
    `SELECT id::text FROM hub_task_status_event WHERE task_key='DEV-1' ORDER BY at,id`,
  )
}

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
  await apply([{ table: 'hub_task', id: taskId, op: 'upsert', row: taskRow() }])
})

beforeEach(resetFixtureStore)

afterAll(async () => {
  if (database) await database.close()
})

test('two machines mint the same transition and the second adopts the hosted id', async () => {
  const firstId = '01990000-0000-7000-8000-000000001402'
  const secondId = '01990000-0000-7000-8000-000000001403'
  const at = '2026-10-12T10:00:00.000Z'
  const first = new Database(':memory:')
  applyMigrations(first)
  const firstChange = mintOn(first, firstId, at)
  expect(await apply([firstChange])).toEqual([{ id: firstId, status: 'applied' }])
  writeTransaction((conn) => insertTaskAndEvent(conn, secondId, at))
  expect((await drainToHosted()).sent).toBe(1)
  expect((await hostedEventIds()).rows).toEqual([{ id: firstId }])
  expect(
    first.query<{ record_id: string }, []>(`SELECT record_id FROM task_status_event`).get(),
  ).toEqual({ record_id: firstId })
  expect(
    db().query<{ record_id: string }, []>(`SELECT record_id FROM task_status_event`).get(),
  ).toEqual({ record_id: firstId })
  first.close()
})

test('pull adopts before drain, then drain answers duplicate', async () => {
  const hostedId = '01990000-0000-7000-8000-000000001407'
  const machineId = '01990000-0000-7000-8000-000000001408'
  const at = '2026-10-12T11:00:00.000Z'
  expect(
    await apply([
      { table: HOSTED_STATUS_EVENT_TABLE, id: hostedId, op: 'upsert', row: eventRow(hostedId, at) },
    ]),
  ).toEqual([{ id: hostedId, status: 'applied' }])
  writeTransaction((conn) => {
    insertTaskAndEvent(conn, machineId, at)
    conn
      .query(
        `INSERT INTO setting(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(`${HOSTED_CHANGES_CURSOR_KEY}.${spaceId}`, '1')
  })
  await pullHostedTaskChanges({
    baseUrl: 'https://hub.example.test',
    token: 'session',
    registeredProjects: registered(),
    fetch: async (input, init) => {
      const url = new URL(input)
      if (url.pathname === '/v1/tasks/identity') return Response.json(await pushIdentity())
      return Response.json({
        head: 20,
        oldest: 1,
        next: 2,
        more: false,
        resetRequired: false,
        changes: [
          {
            sequence: 2,
            table: HOSTED_STATUS_EVENT_TABLE,
            id: hostedId,
            op: 'upsert',
            row: eventRow(hostedId, at),
          },
        ],
      })
    },
  })
  expect(db().query<{ record_id: string }, []>(`SELECT record_id FROM task_status_event`).get()).toEqual(
    { record_id: hostedId },
  )
  expect(
    db()
      .query<{ row_id: string }, []>(
        `SELECT row_id FROM hosted_outbox WHERE table_name='${HOSTED_STATUS_EVENT_TABLE}'`,
      )
      .get(),
  ).toEqual({ row_id: hostedId })
  const sent: HostedPushChange[] = []
  const report = await drainHostedOutbox({
    identity: pushIdentity,
    registered,
    push: async (changes) => {
      sent.push(...changes)
      return apply(changes)
    },
  })
  expect(report.sent).toBe(1)
  expect(sent).toEqual([
    expect.objectContaining({ id: hostedId, table: HOSTED_STATUS_EVENT_TABLE }),
  ])
  expect((await hostedEventIds()).rows.filter((row) => row.id === hostedId)).toHaveLength(1)
})

test('a transition one millisecond later is a second event', async () => {
  const firstId = '01990000-0000-7000-8000-000000001409'
  const laterId = '01990000-0000-7000-8000-000000001410'
  const at = '2026-10-12T12:00:00.000Z'
  const later = '2026-10-12T12:00:00.001Z'
  expect(
    await apply([
      { table: HOSTED_STATUS_EVENT_TABLE, id: firstId, op: 'upsert', row: eventRow(firstId, at) },
    ]),
  ).toEqual([{ id: firstId, status: 'applied' }])
  expect(
    await apply([
      { table: HOSTED_STATUS_EVENT_TABLE, id: laterId, op: 'upsert', row: eventRow(laterId, later) },
    ]),
  ).toEqual([{ id: laterId, status: 'applied' }])
  expect((await hostedEventIds()).rows).toEqual(
    expect.arrayContaining([{ id: firstId }, { id: laterId }]),
  )
})

test('a quarantined collision converges after retry', async () => {
  const hostedId = '01990000-0000-7000-8000-000000001405'
  const machineId = '01990000-0000-7000-8000-000000001406'
  const at = '2026-10-12T13:00:00.000Z'
  expect(
    await apply([
      { table: HOSTED_STATUS_EVENT_TABLE, id: hostedId, op: 'upsert', row: eventRow(hostedId, at) },
    ]),
  ).toEqual([{ id: hostedId, status: 'applied' }])
  writeTransaction((conn) => {
    insertTaskAndEvent(conn, machineId, at)
    conn
      .query(
        `UPDATE hosted_outbox SET attempts=3,quarantined_at=?,quarantine_reason=?
         WHERE table_name=? AND row_id=?`,
      )
      .run(at, 'already belongs', HOSTED_STATUS_EVENT_TABLE, machineId)
  })
  const entryId = db()
    .query<{ id: string }, []>(`SELECT id FROM hosted_outbox WHERE row_id=?`)
    .get(machineId)!.id
  expect(runHostedOutboxCommand(['outbox', 'retry', entryId])).toEqual([
    `outbox entry ${entryId} queued for retry`,
  ])
  expect((await drainToHosted()).sent).toBe(1)
  expect(db().query<{ record_id: string }, []>(`SELECT record_id FROM task_status_event`).get()).toEqual(
    { record_id: hostedId },
  )
  expect((await hostedEventIds()).rows.filter((row) => row.id === hostedId || row.id === machineId)).toEqual(
    [{ id: hostedId }],
  )
  expect(db().query(`SELECT 1 FROM hosted_outbox`).all()).toHaveLength(0)
})
