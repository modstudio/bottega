import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  createHostedRecordFixture,
  HOSTED_FIXTURE_MACHINE_ID,
  pgliteSql,
} from '../test/hosted-record-fixture.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { applyHostedPushChangesInTransaction } from './hosted-push-changes.ts'
import { loadOutboxChange } from './outbox-row.ts'
import {
  type HostedPushChange,
  type PushedDay,
  type PushedInterval,
  parseHostedPushItem,
} from './push-contract.ts'
import { rollUpDays } from './query.ts'

const spaceId = '01990000-0000-7000-8000-000000008301'
const userId = '01990000-0000-7000-8000-000000008302'
const intervalId = '01990000-0000-7000-8000-000000008303'
const projectId = '01990000-0000-7000-8000-000000008305'
const taskId = '01990000-0000-7000-8000-000000008306'
const dayId = '01990000-0000-7000-8000-000000008304'
const secondMachineId = '01990000-0000-7000-8000-000000008320'
const foreignUserId = '01990000-0000-7000-8000-000000008321'
const foreignMachineId = '01990000-0000-7000-8000-000000008322'
const identity = { userId, spaceId }
let database: PGlite

const interval: PushedInterval = {
  id: intervalId,
  task_key: null,
  project_name: 'workshop',
  projectId,
  source: 'orch',
  agent: null,
  job: null,
  start_at: '2026-10-11T10:00:00.000Z',
  end_at: '2026-10-11T10:01:00.000Z',
  claude_tokens: 10,
  vendor_tokens: 20,
  vendor_cost_usd: null,
  ref: 'orch:8303',
  via: null,
  open: 0,
  session_id: null,
  user_id: null,
}
const day: PushedDay = {
  id: dayId,
  machine_id: HOSTED_FIXTURE_MACHINE_ID,
  day: '2026-10-11',
  claude_tokens: 10,
  cache_read: 0,
  messages: 1,
  tasks: 1,
  canon_tokens: 0,
  other_tokens: 0,
  commits: 1,
  files: 1,
  lines_product: 1,
  lines_test: 0,
  lines_docs: 0,
  lines_config: 0,
  lines_generated: 0,
  collected_at: '2026-10-11T23:00:00.000Z',
}

const apply = (inputs: HostedPushChange[]) =>
  database.transaction(async (transaction) => {
    const sql = pgliteSql(transaction as unknown as PGlite)
    sql.unsafe = (async (statement: string) =>
      (await transaction.query(statement)).rows) as SQL['unsafe']
    return applyHostedPushChangesInTransaction(sql, identity, inputs)
  })

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
  await database.exec(`
    RESET ROLE;
    INSERT INTO project (id,space_id,name,created_at)
    VALUES ('${projectId}','${spaceId}','workshop',now());
    INSERT INTO hub_task
      (id,space_id,project_name,project_id,key,project,source,first_seen,last_seen,created_at,updated_at)
    VALUES
      ('${taskId}','${spaceId}','workshop','${projectId}','DEV-1764','workshop','local',now(),now(),now(),now());
    INSERT INTO "user" (id,email,name,created_at)
    VALUES ('${foreignUserId}','foreign@example.test','Foreign',now());
    INSERT INTO machine (id,user_id,name,registered_at,last_seen) VALUES
      ('${secondMachineId}','${userId}','second',now(),now()),
      ('${foreignMachineId}','${foreignUserId}','foreign',now(),now());
    SET ROLE record_actor;
    SELECT set_config('app.user_id','${userId}',false);
    SELECT set_config('app.space_id','${spaceId}',false);
    SELECT set_config('app.space_ids','${spaceId}',false);
  `)
})

beforeEach(resetFixtureStore)

afterAll(async () => {
  if (database) await database.close()
})

test('the edge accepts evidence and unchanged resends append no hosted changes', async () => {
  const inputs: HostedPushChange[] = [
    { table: 'hub_interval', id: intervalId, op: 'upsert', row: interval },
    { table: 'hub_day', id: dayId, op: 'upsert', row: day },
  ]
  expect(inputs.map(parseHostedPushItem)).toEqual(inputs.map((input) => ({ input })))
  expect(await apply(inputs)).toEqual([
    { id: intervalId, status: 'applied' },
    { id: dayId, status: 'applied' },
  ])
  const before = (
    await database.query<{ count: number }>(
      `SELECT count(*)::int count FROM hub_change WHERE table_name IN ('hub_interval','hub_day')`,
    )
  ).rows[0]!.count
  expect(await apply(inputs)).toEqual([
    { id: intervalId, status: 'duplicate' },
    { id: dayId, status: 'duplicate' },
  ])
  const after = (
    await database.query<{ count: number }>(
      `SELECT count(*)::int count FROM hub_change WHERE table_name IN ('hub_interval','hub_day')`,
    )
  ).rows[0]!.count
  expect(after).toBe(before)
})

test('interval pushes carry task UUIDs and an older omitted field preserves the link', async () => {
  const id = '01990000-0000-7000-8000-000000008307'
  const linked = { ...interval, id, ref: 'orch:8307', task_key: 'DEV-1764', task_id: taskId }
  expect(await apply([{ table: 'hub_interval', id, op: 'upsert', row: linked }])).toEqual([
    { id, status: 'applied' },
  ])
  expect(
    await apply([
      {
        table: 'hub_interval',
        id,
        op: 'upsert',
        row: { ...interval, id, ref: 'orch:8307', task_key: 'legacy-label', vendor_tokens: 21 },
      },
    ]),
  ).toEqual([{ id, status: 'applied' }])
  expect(
    (
      await database.query<{ task_id: string; task_key: string; vendor_tokens: number }>(
        `SELECT task_id::text,task_key,vendor_tokens::int FROM hub_interval WHERE id=$1::uuid`,
        [id],
      )
    ).rows[0],
  ).toEqual({ task_id: taskId, task_key: 'legacy-label', vendor_tokens: 21 })
})

test('day identity is per machine and legacy rows are claimed', async () => {
  const first = { ...day, id: '01990000-0000-7000-8000-000000008330', day: '2026-10-20' }
  const second = {
    ...first,
    id: '01990000-0000-7000-8000-000000008331',
    machine_id: secondMachineId,
    claude_tokens: 20,
  }
  expect(
    await apply([
      { table: 'hub_day', id: first.id, op: 'upsert', row: first },
      { table: 'hub_day', id: second.id, op: 'upsert', row: second },
    ]),
  ).toEqual([
    { id: first.id, status: 'applied' },
    { id: second.id, status: 'applied' },
  ])
  expect((await database.query(`SELECT id FROM hub_day WHERE day='2026-10-20'`)).rows).toHaveLength(
    2,
  )
  const firstOnly = {
    ...first,
    id: '01990000-0000-7000-8000-000000008335',
    day: '2026-10-19',
  }
  expect(
    await apply([{ table: 'hub_day', id: firstOnly.id, op: 'upsert', row: firstOnly }]),
  ).toEqual([{ id: firstOnly.id, status: 'applied' }])
  const wrongOwner = { ...firstOnly, machine_id: secondMachineId }
  expect(
    (await apply([{ table: 'hub_day', id: firstOnly.id, op: 'upsert', row: wrongOwner }]))[0],
  ).toMatchObject({ status: 'rejected' })
  expect(
    (
      await database.query<{ machine_id: string }>(
        `SELECT machine_id::text machine_id FROM hub_day WHERE id=$1`,
        [firstOnly.id],
      )
    ).rows[0]!.machine_id,
  ).toBe(HOSTED_FIXTURE_MACHINE_ID)
  const secondNewest = {
    ...second,
    id: '01990000-0000-7000-8000-000000008334',
    day: '2026-10-21',
  }
  await apply([{ table: 'hub_day', id: secondNewest.id, op: 'upsert', row: secondNewest }])
  const firstRefreshed = { ...first, collected_at: '2026-10-20T23:30:00.000Z' }
  expect(
    await apply([{ table: 'hub_day', id: first.id, op: 'upsert', row: firstRefreshed }]),
  ).toEqual([{ id: first.id, status: 'applied' }])

  const conflict = { ...first, id: '01990000-0000-7000-8000-000000008332' }
  expect(
    (await apply([{ table: 'hub_day', id: conflict.id, op: 'upsert', row: conflict }]))[0],
  ).toMatchObject({ status: 'rejected' })
  for (const machineId of ['01990000-0000-7000-8000-000000008399', foreignMachineId]) {
    const rejected = { ...first, id: Bun.randomUUIDv7(), machine_id: machineId, day: '2026-10-21' }
    expect(
      (await apply([{ table: 'hub_day', id: rejected.id, op: 'upsert', row: rejected }]))[0],
    ).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining(`run ${PLATFORM_SLUG} record sync`),
    })
  }

  const legacyId = '01990000-0000-7000-8000-000000008333'
  await database.exec(`RESET ROLE; INSERT INTO hub_day
    (id,space_id,day,claude_tokens,cache_read,messages,tasks,canon_tokens,other_tokens,
     commits,files,lines_product,lines_test,lines_docs,lines_config,lines_generated,
     collected_at,updated_at) VALUES
    ('${legacyId}','${spaceId}','2026-10-22',10,0,1,1,0,0,1,1,1,0,0,0,0,
     '2026-10-11T23:00:00.000Z',now());
    SET ROLE record_actor;
    SELECT set_config('app.user_id','${userId}',false);
    SELECT set_config('app.space_id','${spaceId}',false);
    SELECT set_config('app.space_ids','${spaceId}',false);`)
  const claimed = { ...first, id: legacyId, day: '2026-10-22' }
  expect(await apply([{ table: 'hub_day', id: legacyId, op: 'upsert', row: claimed }])).toEqual([
    { id: legacyId, status: 'applied' },
  ])
  expect(
    (
      await database.query<{ machine_id: string }>(
        `SELECT machine_id::text machine_id FROM hub_day WHERE id=$1`,
        [legacyId],
      )
    ).rows[0]!.machine_id,
  ).toBe(HOSTED_FIXTURE_MACHINE_ID)
  expect(
    (
      await database.query<{ count: number }>(
        `SELECT count(*)::int count FROM hub_day
         WHERE machine_id=$1::uuid AND day='2026-10-22'`,
        [HOSTED_FIXTURE_MACHINE_ID],
      )
    ).rows[0]!.count,
  ).toBe(1)
  expect(
    await apply([
      {
        table: 'hub_day',
        id: first.id,
        op: 'upsert',
        row: { ...firstRefreshed, collected_at: '2026-10-20T23:45:00.000Z' },
      },
    ]),
  ).toEqual([{ id: first.id, status: 'duplicate' }])
})

test('an absent interval delete is duplicate and a present interval delete applies', async () => {
  const absent = '01990000-0000-7000-8000-000000008305'
  expect(await apply([{ table: 'hub_interval', id: absent, op: 'delete' }])).toEqual([
    { id: absent, status: 'duplicate' },
  ])
  expect(await apply([{ table: 'hub_interval', id: intervalId, op: 'delete' }])).toEqual([
    { id: intervalId, status: 'applied' },
  ])
})

test('real and legacy machine day timestamps serialize through the strict edge', async () => {
  writeTransaction((conn) => {
    conn
      .query(`INSERT INTO interval(record_id,project_record_id,source,start_at,end_at,claude_tokens,ref)
        VALUES ('01990000-0000-7000-8000-000000008310','project-id','claude',
          '2026-10-09T10:00:00.000Z','2026-10-09T10:01:00.000Z',10,'claude:day-wire')`)
      .run()
  })
  expect(rollUpDays()).toBe(1)
  const current = db()
    .query<{ record_id: string; collected_at: string }, []>(
      `SELECT record_id,collected_at FROM day WHERE day='2026-10-09'`,
    )
    .get()!
  expect(current.collected_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  const legacyId = '01990000-0000-7000-8000-000000008311'
  writeTransaction((conn) =>
    conn
      .query(`INSERT INTO day(record_id,machine_id,day,collected_at)
        VALUES (?,?,'2026-10-10','2026-10-10 23:00:00')`)
      .run(legacyId, day.machine_id),
  )
  const inputs = [current.record_id, legacyId].map((rowId) =>
    loadOutboxChange(db(), { table_name: 'hub_day', row_id: rowId, operation: 'upsert' }),
  )
  expect(inputs.every(Boolean)).toBeTrue()
  const changes = inputs.map((loaded) => loaded!.change)
  expect(changes.map(parseHostedPushItem)).toEqual(changes.map((input) => ({ input })))
  const localMachine = (changes[0] as { row: PushedDay }).row.machine_id
  await database.exec(`RESET ROLE; INSERT INTO machine(id,user_id,name,registered_at,last_seen)
    VALUES ('${localMachine}','${userId}','local',now(),now()) ON CONFLICT (id) DO NOTHING;
    SET ROLE record_actor;
    SELECT set_config('app.user_id','${userId}',false);
    SELECT set_config('app.space_id','${spaceId}',false);
    SELECT set_config('app.space_ids','${spaceId}',false);`)
  expect(await apply(changes)).toEqual(
    changes.map(({ id }) => ({ id, status: 'applied' as const })),
  )
  expect(await apply(changes)).toEqual(
    changes.map(({ id }) => ({ id, status: 'duplicate' as const })),
  )
})
