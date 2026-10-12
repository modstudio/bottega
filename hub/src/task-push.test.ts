import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { RECORD_ACTOR_ROLE } from '../../shared/record/schema.ts'
import { bindTenant } from '../../shared/record/tenant.ts'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { writeTransaction } from './db.ts'
import { readHostedIdentitySetInTransaction } from './hosted-identity-set.ts'
import { applyHostedPushChangesInTransaction } from './hosted-push-changes.ts'
import { listHostedOutbox, queueHostedChange } from './outbox.ts'
import {
  HOSTED_TASK_TABLE,
  type HostedPushChange,
  PUSHABLE_HUB_CHANGE_TABLES,
} from './push-contract.ts'
import type { HostedTaskIdentity } from './task-client.ts'
import { formatTaskPushReport, pushTasks } from './task-push.ts'
import { compareIdentitySets } from './task-push-plan.ts'

const spaceA = '01990000-0000-7000-8000-000000008501'
const spaceB = '01990000-0000-7000-8000-000000008502'
const userId = '01990000-0000-7000-8000-000000008500'
const taskA = '01990000-0000-7000-8000-000000008511'
const taskB = '01990000-0000-7000-8000-000000008512'
const missingHosted = '01990000-0000-7000-8000-000000008513'
const hostedOnly = '01990000-0000-7000-8000-000000008514'
const inFlightId = '01990000-0000-7000-8000-000000008515'
const pageIds = [
  '01990000-0000-7000-8000-000000008521',
  '01990000-0000-7000-8000-000000008522',
  '01990000-0000-7000-8000-000000008523',
] as const
const at = '2026-10-12T12:00:00.000Z'

const registered = [
  { name: 'workshop', settings: { space: 'one' } },
  { name: 'other', settings: { space: 'two' } },
]
const identity: HostedTaskIdentity = {
  userId,
  activeSpaceId: spaceA,
  memberships: [
    { spaceId: spaceA, slug: 'one', permission: 'write' },
    { spaceId: spaceB, slug: 'two', permission: 'write' },
  ],
  capabilities: {
    spaceIdentitySet: true,
    spacePush: true,
    spacePushTables: [...PUSHABLE_HUB_CHANGE_TABLES],
  },
}

let database: PGlite

const applyOn = (spaceId: string, inputs: HostedPushChange[]) =>
  database.transaction(async (transaction) => {
    const sql = pgliteSql(transaction as unknown as PGlite)
    sql.unsafe = (async (statement: string) =>
      (await transaction.query(statement)).rows) as SQL['unsafe']
    await bindTenant(sql, { userId, spaceId })
    return applyHostedPushChangesInTransaction(sql, { userId, spaceId }, inputs)
  })

const listIds: typeof import('./task-client.ts').hostedIdentitySet = async (
  table,
  options = {},
) => {
  const spaceId = options.recordSpace ?? spaceA
  return database.transaction(async (transaction) => {
    const sql = pgliteSql(transaction as unknown as PGlite)
    await bindTenant(sql, { userId, spaceId })
    return readHostedIdentitySetInTransaction(
      sql,
      { userId, spaceId },
      {
        table,
        after: options.after ?? null,
        limit: 50,
      },
    )
  })
}

function insertMachineTask(id: string, key: string, project: string) {
  writeTransaction((conn) => {
    conn
      .query(
        `INSERT INTO task(record_id,key,project,title,status,status_category,source,first_seen,last_seen)
         VALUES (?,?,?,?, 'open','open','local',?,?)`,
      )
      .run(id, key, project, key, at, at)
  })
}

function hostedTaskRow(id: string, key: string, project: string) {
  return {
    id,
    key,
    project,
    project_name: project,
    title: key,
    status: 'open' as const,
    status_category: 'open' as const,
    parent_key: null,
    body: null,
    assignee: null,
    opened_at: at,
    closed_at: null,
    source: 'local' as const,
    first_seen: at,
    last_seen: at,
    created_at: at,
    updated_at: at,
    deleted_at: null,
    next_document_number: 1,
  }
}

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId: spaceA, userId })
  await database.exec(`
    RESET ROLE;
    INSERT INTO space (id,name,slug,created_at)
    VALUES ('${spaceB}','Push B','push-b',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
    VALUES ('01990000-0000-7000-8000-000000008503','${spaceB}','${userId}','member','write',now());
    SET ROLE ${RECORD_ACTOR_ROLE};
  `)
})

beforeEach(async () => {
  resetFixtureStore()
  await database.exec(`
    RESET ROLE;
    SET ROLE record_owner;
    DELETE FROM hub_task;
    DELETE FROM hub_task_comment;
    DELETE FROM hub_task_document;
    DELETE FROM hub_task_status_event;
    DELETE FROM hub_interval;
    DELETE FROM hub_day;
    SET ROLE ${RECORD_ACTOR_ROLE};
  `)
})

afterAll(async () => {
  if (database) await database.close()
})

const runPush = (repair = false) =>
  pushTasks({
    repair,
    identity: async () => identity,
    listIds,
    registered: () => registered,
    drain: async (dependencies) => {
      const { drainHostedOutbox } = await import('./outbox.ts')
      return drainHostedOutbox({
        ...dependencies,
        identity: async () => identity,
        registered: () => registered,
        push: async (changes, options) => applyOn(options.recordSpace ?? spaceA, changes),
      })
    },
  })

test('compareIdentitySets counts in-flight separately from missing', () => {
  expect(compareIdentitySets(['a', 'b', 'c'], ['a', 'd'], new Set(['c']))).toEqual({
    both: 1,
    machineOnly: ['b'],
    hostedOnly: ['d'],
    inFlight: ['c'],
  })
})

test('task push reports nothing missing when the sides agree', async () => {
  insertMachineTask(taskA, 'DEV-1', 'workshop')
  await applyOn(spaceA, [
    {
      table: HOSTED_TASK_TABLE,
      id: taskA,
      op: 'upsert',
      row: hostedTaskRow(taskA, 'DEV-1', 'workshop'),
    },
  ])
  const report = await runPush()
  const tasks = report.spaces
    .find((space) => space.spaceId === spaceA)
    ?.tables.find((table) => table.table === HOSTED_TASK_TABLE)
  expect(tasks).toMatchObject({ both: 1, machineOnly: [], hostedOnly: [], inFlight: [] })
  expect(report.ok).toBeTrue()
  expect(report.drain).toBeNull()
})

test('a hosted delete is only-on-machine and --repair restores it through the outbox', async () => {
  insertMachineTask(missingHosted, 'DEV-miss', 'workshop')
  const before = await runPush()
  const tasks = before.spaces
    .find((space) => space.spaceId === spaceA)
    ?.tables.find((table) => table.table === HOSTED_TASK_TABLE)
  expect(tasks?.machineOnly).toEqual([missingHosted])
  expect(listHostedOutbox()).toEqual([])
  const repaired = await runPush(true)
  expect(listHostedOutbox()).toEqual([])
  expect(repaired.drain?.sent).toBe(1)
  const after = await listIds(HOSTED_TASK_TABLE, { recordSpace: spaceA })
  expect(after.ids).toContain(missingHosted)
})

test('a row only on the hosted record is reported and not touched', async () => {
  await applyOn(spaceA, [
    {
      table: HOSTED_TASK_TABLE,
      id: hostedOnly,
      op: 'upsert',
      row: hostedTaskRow(hostedOnly, 'DEV-host', 'workshop'),
    },
  ])
  const before = (
    await database.query<{ count: number }>(
      `SELECT count(*)::int count FROM hub_task WHERE id=$1`,
      [hostedOnly],
    )
  ).rows[0]!.count
  const report = await runPush(true)
  const tasks = report.spaces
    .find((space) => space.spaceId === spaceA)
    ?.tables.find((table) => table.table === HOSTED_TASK_TABLE)
  expect(tasks?.hostedOnly).toEqual([hostedOnly])
  expect(report.ok).toBeFalse()
  expect(
    (
      await database.query<{ count: number }>(
        `SELECT count(*)::int count FROM hub_task WHERE id=$1`,
        [hostedOnly],
      )
    ).rows[0]!.count,
  ).toBe(before)
  expect(formatTaskPushReport(report)).toContain('The machine has no command to fetch them yet.')
  expect(formatTaskPushReport(report)).not.toContain('hub collect')
})

test('a pending outbox entry is in flight not missing', async () => {
  insertMachineTask(inFlightId, 'DEV-fly', 'workshop')
  writeTransaction((conn) => queueHostedChange(conn, HOSTED_TASK_TABLE, inFlightId, 'upsert'))
  const report = await runPush()
  const tasks = report.spaces
    .find((space) => space.spaceId === spaceA)
    ?.tables.find((table) => table.table === HOSTED_TASK_TABLE)
  expect(tasks?.inFlight).toEqual([inFlightId])
  expect(tasks?.machineOnly).toEqual([])
})

test('task push follows more than one identity-set page', async () => {
  const calls: Array<string | null | undefined> = []
  const report = await pushTasks({
    identity: async () => identity,
    registered: () => registered,
    listIds: async (table, options = {}) => {
      if (table !== HOSTED_TASK_TABLE || options.recordSpace !== spaceA)
        return { ids: [], more: false }
      calls.push(options.after)
      if (!options.after) return { ids: [pageIds[0], pageIds[1]], more: true }
      return { ids: [pageIds[2]], more: false }
    },
  })
  expect(calls).toEqual([null, pageIds[1]])
  const tasks = report.spaces
    .find((space) => space.spaceId === spaceA)
    ?.tables.find((table) => table.table === HOSTED_TASK_TABLE)
  expect(tasks?.hostedOnly).toEqual([...pageIds])
})

test("a second space's rows are not counted against the first", async () => {
  insertMachineTask(taskA, 'DEV-1', 'workshop')
  insertMachineTask(taskB, 'OTH-1', 'other')
  await applyOn(spaceA, [
    {
      table: HOSTED_TASK_TABLE,
      id: taskA,
      op: 'upsert',
      row: hostedTaskRow(taskA, 'DEV-1', 'workshop'),
    },
  ])
  await applyOn(spaceB, [
    {
      table: HOSTED_TASK_TABLE,
      id: taskB,
      op: 'upsert',
      row: hostedTaskRow(taskB, 'OTH-1', 'other'),
    },
  ])
  const report = await runPush()
  const first = report.spaces
    .find((space) => space.spaceId === spaceA)
    ?.tables.find((table) => table.table === HOSTED_TASK_TABLE)
  const second = report.spaces
    .find((space) => space.spaceId === spaceB)
    ?.tables.find((table) => table.table === HOSTED_TASK_TABLE)
  expect(first).toMatchObject({ both: 1, machineOnly: [], hostedOnly: [] })
  expect(second).toMatchObject({ both: 1, machineOnly: [], hostedOnly: [] })
  expect(first?.machineOnly).not.toContain(taskB)
  expect(second?.machineOnly).not.toContain(taskA)
})

test('without --repair nothing is written', async () => {
  insertMachineTask(missingHosted, 'DEV-miss', 'workshop')
  const report = await runPush(false)
  expect(report.drain).toBeNull()
  expect(listHostedOutbox()).toEqual([])
  const hosted = await listIds(HOSTED_TASK_TABLE, { recordSpace: spaceA })
  expect(hosted.ids).not.toContain(missingHosted)
})

test('task push refuses a hub that does not advertise spaceIdentitySet', async () => {
  await expect(
    pushTasks({
      identity: async () => ({ ...identity, capabilities: {} }),
      listIds: async () => ({ ids: [], more: false }),
      registered: () => registered,
    }),
  ).rejects.toThrow('hosted hub does not advertise space identity set support')
})
