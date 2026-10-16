import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { HUB_MIGRATION_BACKFILL_VALUES } from '../test/migration-values.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { pullHostedTaskChanges } from './hosted-change-cache.ts'
import { DELETED_ON_HOSTED_RECORD_REASON } from './hosted-delete.ts'
import { applyHostedPushChangesInTransaction } from './hosted-push-changes.ts'
import { HOSTED_CHANGES_CURSOR_KEY } from './hosted-task-change-family.ts'
import { applyMigrations } from './migrations.ts'
import { drainHostedOutbox, queueHostedChange, retryHostedOutboxEntryCommand } from './outbox.ts'
import { loadOutboxChange } from './outbox-row.ts'
import {
  HOSTED_STATUS_EVENT_TABLE,
  HOSTED_TASK_TABLE,
  type HostedPushChange,
  type PushedStatusEvent,
  type PushedTask,
} from './push-contract.ts'
import type { HostedTaskIdentity } from './task-client.ts'

const spaceId = '01990000-0000-7000-8000-000000001400'
const taskId = '01990000-0000-7000-8000-000000001401'
const userId = '01990000-0000-7000-8000-000000001399'
const projectId = '01990000-0000-7000-8000-000000001498'
const identity = { userId, spaceId }
let database: PGlite

const taskRow = (): PushedTask => ({
  id: taskId,
  key: 'DEV-1',
  project: 'workshop',
  project_name: 'workshop',
  projectId,
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

const eventRow = (
  id: string,
  at: string,
  overrides: Partial<PushedStatusEvent> = {},
): PushedStatusEvent => ({
  id,
  task_key: 'DEV-1',
  task_id: taskId,
  project_name: 'workshop',
  projectId,
  at,
  from_status: 'open',
  to_status: 'active',
  created_at: at,
  updated_at: at,
  deleted_at: null,
  ...overrides,
})

const apply = (inputs: HostedPushChange[]) =>
  database.transaction(async (transaction) => {
    const sql = pgliteSql(transaction as unknown as PGlite)
    sql.unsafe = (async (statement: string) =>
      (await transaction.query(statement)).rows) as SQL['unsafe']
    return applyHostedPushChangesInTransaction(sql, identity, inputs)
  })

const registered = () => [{ name: 'workshop', settings: { keyPrefixes: ['DEV'], space: spaceId } }]

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

function insertTaskAndEvent(
  conn: Database,
  eventId: string,
  at: string,
  options: {
    taskId?: string
    fromStatus?: string
    toStatus?: string
    queueTask?: boolean
    queueEvent?: boolean
  } = {},
) {
  const localTaskId = options.taskId ?? taskId
  conn
    .query(
      `INSERT INTO task (record_id,key,project,project_record_id,title,status,status_category,source,first_seen,last_seen)
       VALUES (?,'DEV-1','workshop',?,'First','active','active','mcp',?,?)`,
    )
    .run(localTaskId, projectId, at, at)
  if (options.queueTask) queueHostedChange(conn, HOSTED_TASK_TABLE, localTaskId, 'upsert', at)
  conn
    .query(
      `INSERT INTO task_status_event (record_id,task_key,task_record_id,at,from_status,to_status)
       VALUES (?,'DEV-1',?,?,?,?)`,
    )
    .run(eventId, localTaskId, at, options.fromStatus ?? 'open', options.toStatus ?? 'active')
  if (options.queueEvent !== false)
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

async function hostedIds(ids: string[]) {
  return (
    await database.query<{ id: string }>(
      `SELECT id::text FROM hub_task_status_event WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [ids],
    )
  ).rows
}

function machineEvent() {
  return db()
    .query<{ record_id: string; from_status: string | null; to_status: string }, []>(
      `SELECT record_id,from_status,to_status FROM task_status_event`,
    )
    .all()
}

function eventOutbox() {
  return db()
    .query<{ row_id: string; quarantined_at: string | null }, []>(
      `SELECT row_id,quarantined_at FROM hosted_outbox WHERE table_name='${HOSTED_STATUS_EVENT_TABLE}'`,
    )
    .all()
}

function hostedCursor() {
  return (
    db()
      .query<{ value: string }, [string]>(`SELECT value FROM setting WHERE key=?`)
      .get(`${HOSTED_CHANGES_CURSOR_KEY}.${spaceId}`)?.value ?? null
  )
}

function seedCursor(conn: Database) {
  conn
    .query(
      `INSERT INTO setting(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    )
    .run(`${HOSTED_CHANGES_CURSOR_KEY}.${spaceId}`, '1')
}

async function pullStatusEvent(row: PushedStatusEvent) {
  await pullHostedTaskChanges({
    baseUrl: 'https://hub.example.test',
    token: 'session',
    registeredProjects: registered(),
    fetch: async (input) => {
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
            id: row.id,
            op: 'upsert',
            row,
          },
        ],
      })
    },
  })
}

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
  await database.exec(`INSERT INTO project(id,space_id,name,created_at)
    VALUES ('${projectId}','${spaceId}','workshop',now())`)
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
  applyMigrations(first, undefined, HUB_MIGRATION_BACKFILL_VALUES)
  const firstChange = mintOn(first, firstId, at)
  expect(await apply([firstChange])).toEqual([{ id: firstId, status: 'applied' }])
  first.close()
  writeTransaction((conn) => insertTaskAndEvent(conn, secondId, at))
  expect((await drainToHosted()).sent).toBe(1)
  expect(await hostedIds([firstId, secondId])).toEqual([{ id: firstId }])
  expect(machineEvent()).toEqual([{ record_id: firstId, from_status: 'open', to_status: 'active' }])
})

test('two machines whose task ids and event ids both differ share one hosted event', async () => {
  const firstEventId = '01990000-0000-7000-8000-000000001411'
  const secondTaskId = '01990000-0000-7000-8000-000000001412'
  const secondEventId = '01990000-0000-7000-8000-000000001413'
  const at = '2026-10-12T14:00:00.000Z'
  const first = new Database(':memory:')
  applyMigrations(first, undefined, HUB_MIGRATION_BACKFILL_VALUES)
  expect(await apply([mintOn(first, firstEventId, at)])).toEqual([
    { id: firstEventId, status: 'applied' },
  ])
  first.close()
  writeTransaction((conn) =>
    insertTaskAndEvent(conn, secondEventId, at, {
      taskId: secondTaskId,
      queueTask: true,
    }),
  )
  expect((await drainToHosted()).sent).toBe(2)
  expect(await hostedIds([firstEventId, secondEventId])).toEqual([{ id: firstEventId }])
  expect(machineEvent().map((row) => row.record_id)).toEqual([firstEventId])
  expect(db().query<{ record_id: string }, []>(`SELECT record_id FROM task`).get()).toEqual({
    record_id: taskId,
  })
})

test('a holder found by task id is the same event when its stored key snapshot differs', async () => {
  const hostedId = '01990000-0000-7000-8000-000000001414'
  const incomingId = '01990000-0000-7000-8000-000000001415'
  const at = '2026-10-12T15:00:00.000Z'
  expect(
    await apply([
      {
        table: HOSTED_STATUS_EVENT_TABLE,
        id: hostedId,
        op: 'upsert',
        row: eventRow(hostedId, at, { task_key: 'DEV-STALE' }),
      },
    ]),
  ).toEqual([{ id: hostedId, status: 'applied' }])
  expect(
    await apply([
      {
        table: HOSTED_STATUS_EVENT_TABLE,
        id: incomingId,
        op: 'upsert',
        row: eventRow(incomingId, at),
      },
    ]),
  ).toEqual([{ id: incomingId, status: 'duplicate', adoptedId: hostedId }])
  expect(await hostedIds([hostedId, incomingId])).toEqual([{ id: hostedId }])
})

test.each([
  {
    label: 'a resolved task record id',
    projectName: 'workshop',
    hostedId: '01990000-0000-7000-8000-000000001407',
    machineId: '01990000-0000-7000-8000-000000001408',
    at: '2026-10-12T11:00:00.000Z',
  },
  {
    label: 'a null task record id',
    projectName: 'missing-project',
    hostedId: '01990000-0000-7000-8000-000000001427',
    machineId: '01990000-0000-7000-8000-000000001428',
    at: '2026-10-12T11:30:00.000Z',
  },
])(
  'pull adopts before drain when the machine event has $label',
  async ({ projectName, hostedId, machineId, at }) => {
    expect(
      await apply([
        {
          table: HOSTED_STATUS_EVENT_TABLE,
          id: hostedId,
          op: 'upsert',
          row: eventRow(hostedId, at),
        },
      ]),
    ).toEqual([{ id: hostedId, status: 'applied' }])
    writeTransaction((conn) => {
      insertTaskAndEvent(conn, machineId, at)
      seedCursor(conn)
    })
    await pullStatusEvent(eventRow(hostedId, at, { project_name: projectName }))
    expect(machineEvent().map((row) => row.record_id)).toEqual([hostedId])
    expect(eventOutbox()).toEqual([{ row_id: hostedId, quarantined_at: null }])
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
      expect.objectContaining({
        id: hostedId,
        table: HOSTED_STATUS_EVENT_TABLE,
      }),
    ])
    expect(await hostedIds([hostedId, machineId])).toEqual([{ id: hostedId }])
  },
)

test('pull adoption takes the hosted row values', async () => {
  const hostedId = '01990000-0000-7000-8000-000000001418'
  const machineId = '01990000-0000-7000-8000-000000001419'
  const at = '2026-10-12T17:00:00.000Z'
  expect(
    await apply([
      {
        table: HOSTED_STATUS_EVENT_TABLE,
        id: hostedId,
        op: 'upsert',
        row: eventRow(hostedId, at),
      },
    ]),
  ).toEqual([{ id: hostedId, status: 'applied' }])
  writeTransaction((conn) => {
    insertTaskAndEvent(conn, machineId, at, { fromStatus: 'todo' })
    seedCursor(conn)
  })
  await pullStatusEvent(eventRow(hostedId, at))
  expect(machineEvent()).toEqual([
    { record_id: hostedId, from_status: 'open', to_status: 'active' },
  ])
  expect(eventOutbox()).toEqual([{ row_id: hostedId, quarantined_at: null }])
  expect((await drainToHosted()).sent).toBe(1)
  expect(await hostedIds([hostedId, machineId])).toEqual([{ id: hostedId }])
})

test('a quarantined status-event entry converges on pull', async () => {
  const hostedId = '01990000-0000-7000-8000-000000001420'
  const machineId = '01990000-0000-7000-8000-000000001421'
  const at = '2026-10-12T18:00:00.000Z'
  expect(
    await apply([
      {
        table: HOSTED_STATUS_EVENT_TABLE,
        id: hostedId,
        op: 'upsert',
        row: eventRow(hostedId, at),
      },
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
    seedCursor(conn)
  })
  await pullStatusEvent(eventRow(hostedId, at))
  expect(machineEvent().map((row) => row.record_id)).toEqual([hostedId])
  expect(eventOutbox()).toEqual([{ row_id: hostedId, quarantined_at: null }])
  expect((await drainToHosted()).sent).toBe(1)
  expect(db().query(`SELECT 1 FROM hosted_outbox`).all()).toHaveLength(0)
  expect(await hostedIds([hostedId, machineId])).toEqual([{ id: hostedId }])
})

test('a machine row that already holds the hosted id drops the duplicate and advances the cursor', async () => {
  const hostedId = '01990000-0000-7000-8000-000000001422'
  const duplicateId = '01990000-0000-7000-8000-000000001423'
  const at = '2026-10-12T19:00:00.000Z'
  expect(
    await apply([
      {
        table: HOSTED_STATUS_EVENT_TABLE,
        id: hostedId,
        op: 'upsert',
        row: eventRow(hostedId, at),
      },
    ]),
  ).toEqual([{ id: hostedId, status: 'applied' }])
  writeTransaction((conn) => {
    insertTaskAndEvent(conn, hostedId, at, {
      toStatus: 'review',
      queueEvent: false,
    })
    conn
      .query(
        `INSERT INTO task_status_event (record_id,task_key,task_record_id,at,from_status,to_status)
         VALUES (?,'DEV-1',?,?,?,?)`,
      )
      .run(duplicateId, taskId, at, 'open', 'active')
    queueHostedChange(conn, HOSTED_STATUS_EVENT_TABLE, duplicateId, 'upsert', at)
    seedCursor(conn)
  })
  await pullStatusEvent(eventRow(hostedId, at))
  expect(machineEvent()).toEqual([
    { record_id: hostedId, from_status: 'open', to_status: 'active' },
  ])
  expect(eventOutbox()).toEqual([{ row_id: hostedId, quarantined_at: null }])
  expect(hostedCursor()).toBe('2')
})

test('a deleted holder is rejected and not adopted', async () => {
  const hostedId = '01990000-0000-7000-8000-000000001416'
  const incomingId = '01990000-0000-7000-8000-000000001417'
  const at = '2026-10-12T16:00:00.000Z'
  expect(
    await apply([
      {
        table: HOSTED_STATUS_EVENT_TABLE,
        id: hostedId,
        op: 'upsert',
        row: eventRow(hostedId, at),
      },
    ]),
  ).toEqual([{ id: hostedId, status: 'applied' }])
  await database.query(`UPDATE hub_task_status_event SET deleted_at=$1 WHERE id=$2`, [at, hostedId])
  expect(
    await apply([
      {
        table: HOSTED_STATUS_EVENT_TABLE,
        id: incomingId,
        op: 'upsert',
        row: eventRow(incomingId, at),
      },
    ]),
  ).toEqual([
    {
      id: incomingId,
      status: 'rejected',
      reason: DELETED_ON_HOSTED_RECORD_REASON,
    },
  ])
  const remaining = await database.query<{
    id: string
    deleted_at: string | null
  }>(`SELECT id::text id, deleted_at FROM hub_task_status_event WHERE id=ANY($1::uuid[])`, [
    [hostedId, incomingId],
  ])
  expect(remaining.rows.map((row) => row.id)).toEqual([hostedId])
  expect(remaining.rows[0]!.deleted_at).not.toBeNull()
})

test('a transition one millisecond later is a second event', async () => {
  const firstId = '01990000-0000-7000-8000-000000001409'
  const laterId = '01990000-0000-7000-8000-000000001410'
  const at = '2026-10-12T12:00:00.000Z'
  const later = '2026-10-12T12:00:00.001Z'
  expect(
    await apply([
      {
        table: HOSTED_STATUS_EVENT_TABLE,
        id: firstId,
        op: 'upsert',
        row: eventRow(firstId, at),
      },
    ]),
  ).toEqual([{ id: firstId, status: 'applied' }])
  expect(
    await apply([
      {
        table: HOSTED_STATUS_EVENT_TABLE,
        id: laterId,
        op: 'upsert',
        row: eventRow(laterId, later),
      },
    ]),
  ).toEqual([{ id: laterId, status: 'applied' }])
  expect(await hostedIds([firstId, laterId])).toEqual([{ id: firstId }, { id: laterId }])
})

test('a quarantined collision converges after retry', async () => {
  const hostedId = '01990000-0000-7000-8000-000000001405'
  const machineId = '01990000-0000-7000-8000-000000001406'
  const at = '2026-10-12T13:00:00.000Z'
  expect(
    await apply([
      {
        table: HOSTED_STATUS_EVENT_TABLE,
        id: hostedId,
        op: 'upsert',
        row: eventRow(hostedId, at),
      },
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
    .query<{ id: string }, [string]>(`SELECT id FROM hosted_outbox WHERE row_id=?`)
    .get(machineId)!.id
  expect(retryHostedOutboxEntryCommand(entryId)).toEqual([
    `outbox entry ${entryId} queued for retry`,
  ])
  expect((await drainToHosted()).sent).toBe(1)
  expect(
    db().query<{ record_id: string }, []>(`SELECT record_id FROM task_status_event`).get(),
  ).toEqual({ record_id: hostedId })
  expect(await hostedIds([hostedId, machineId])).toEqual([{ id: hostedId }])
  expect(db().query(`SELECT 1 FROM hosted_outbox`).all()).toHaveLength(0)
})
