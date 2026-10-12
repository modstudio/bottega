import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { RECORD_ACTOR_ROLE } from '../../shared/record/schema.ts'
import { bindTenant } from '../../shared/record/tenant.ts'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import {
  identitySetRequestInput,
  parseIdentitySetTable,
  readHostedIdentitySetInTransaction,
} from './hosted-identity-set.ts'

const spaceA = '01990000-0000-7000-8000-000000008401'
const spaceB = '01990000-0000-7000-8000-000000008402'
const userId = '01990000-0000-7000-8000-000000008400'
const liveA = '01990000-0000-7000-8000-000000008411'
const liveB = '01990000-0000-7000-8000-000000008412'
const deletedA = '01990000-0000-7000-8000-000000008413'
const pageOne = '01990000-0000-7000-8000-000000008421'
const pageTwo = '01990000-0000-7000-8000-000000008422'
const pageThree = '01990000-0000-7000-8000-000000008423'
const intervalId = '01990000-0000-7000-8000-000000008431'
const identityA = { userId, spaceId: spaceA }
const identityB = { userId, spaceId: spaceB }

let database: PGlite

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId: spaceA, userId })
  await database.exec(`
    RESET ROLE;
    INSERT INTO space (id,name,slug,created_at)
    VALUES ('${spaceB}','Identity B','identity-b',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
    VALUES ('01990000-0000-7000-8000-000000008403','${spaceB}','${userId}','member','write',now());
    SET ROLE ${RECORD_ACTOR_ROLE};
    SELECT set_config('app.user_id','${userId}',false);
    SELECT set_config('app.space_id','${spaceA}',false);
    SELECT set_config('app.space_ids','${spaceA}',false);
    INSERT INTO hub_task
      (id,space_id,project_name,key,project,title,source,first_seen,last_seen,created_at,updated_at)
    VALUES
      ('${liveA}','${spaceA}','workshop','DEV-1','workshop','live a','local',now(),now(),now(),now()),
      ('${pageOne}','${spaceA}','workshop','DEV-21','workshop','page 1','local',now(),now(),now(),now()),
      ('${pageTwo}','${spaceA}','workshop','DEV-22','workshop','page 2','local',now(),now(),now(),now()),
      ('${pageThree}','${spaceA}','workshop','DEV-23','workshop','page 3','local',now(),now(),now(),now());
    INSERT INTO hub_task
      (id,space_id,project_name,key,project,title,source,first_seen,last_seen,created_at,updated_at,deleted_at)
    VALUES
      ('${deletedA}','${spaceA}','workshop','DEV-del','workshop','gone','local',now(),now(),now(),now(),now());
    INSERT INTO hub_interval (id,space_id,source,start_at,end_at,ref,updated_at)
    VALUES ('${intervalId}','${spaceA}','orch',now(),now(),'orch:841',now());
    SELECT set_config('app.space_id','${spaceB}',false);
    SELECT set_config('app.space_ids','${spaceB}',false);
    INSERT INTO hub_task
      (id,space_id,project_name,key,project,title,source,first_seen,last_seen,created_at,updated_at)
    VALUES
      ('${liveB}','${spaceB}','other','OTH-1','other','live b','local',now(),now(),now(),now());
    SELECT set_config('app.space_id','${spaceA}',false);
    SELECT set_config('app.space_ids','${spaceA}',false);
  `)
})

afterAll(async () => {
  if (database) await database.close()
})

test('parseIdentitySetTable accepts every pushable table and refuses others', () => {
  expect(parseIdentitySetTable('hub_interval')).toBe('hub_interval')
  expect(() => parseIdentitySetTable('hub_note')).toThrow(/table must name one of/)
  expect(() =>
    identitySetRequestInput(
      new URL('https://hub.example.test/v1/changes/ids?table=hub_task&after=nope'),
    ),
  ).toThrow('after must be a UUID')
})

async function read(
  identity: { userId: string; spaceId: string },
  input: Parameters<typeof readHostedIdentitySetInTransaction>[2],
) {
  return database.transaction(async (transaction) => {
    const sql = pgliteSql(transaction as unknown as PGlite)
    await bindTenant(sql, identity)
    return readHostedIdentitySetInTransaction(sql, identity, input)
  })
}

test('identity set lists live ids ordered, pages, and stays in the requested space', async () => {
  const live = await read(identityA, {
    table: 'hub_task',
    after: null,
    limit: 50,
  })
  expect(live.ids).toEqual([liveA, pageOne, pageTwo, pageThree])
  expect(live.more).toBeFalse()
  expect(live.ids).not.toContain(deletedA)
  expect(live.ids).not.toContain(liveB)

  const first = await read(identityA, {
    table: 'hub_task',
    after: null,
    limit: 2,
  })
  expect(first).toEqual({ ids: [liveA, pageOne], more: true })
  const second = await read(identityA, {
    table: 'hub_task',
    after: first.ids.at(-1)!,
    limit: 2,
  })
  expect(second).toEqual({ ids: [pageTwo, pageThree], more: false })

  const other = await read(identityB, {
    table: 'hub_task',
    after: null,
    limit: 50,
  })
  expect(other.ids).toEqual([liveB])

  const intervals = await read(identityA, {
    table: 'hub_interval',
    after: null,
    limit: 50,
  })
  expect(intervals.ids).toEqual([intervalId])
})
