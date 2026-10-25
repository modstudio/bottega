import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { createHostedTaskInTransaction, getHostedTask } from './hosted-tasks.ts'

const spaceId = '01990000-0000-7000-8000-000000001430'
const otherSpaceId = '01990000-0000-7000-8000-000000001431'
const userId = '01990000-0000-7000-8000-000000001432'
const liveTaskId = '01990000-0000-7000-8000-000000001433'
const deletedTaskId = '01990000-0000-7000-8000-000000001434'
const otherSpaceTaskId = '01990000-0000-7000-8000-000000001435'
const projectId = '01990000-0000-7000-8000-000000001436'
const at = '2026-10-20T12:00:00.000Z'
let database: PGlite

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
  await database.exec(`
    RESET ROLE;
    INSERT INTO space (id,name,slug,created_at)
    VALUES ('${otherSpaceId}','Other space','other-space','${at}');
    INSERT INTO project (id,space_id,name,key_prefixes,created_at)
    VALUES ('${projectId}','${spaceId}','one',ARRAY['DEV'],now());
    INSERT INTO hub_task
      (id,space_id,project_name,key,project,title,source,first_seen,last_seen,created_at,updated_at,deleted_at)
    VALUES
      ('${liveTaskId}','${spaceId}','one','DEV-1','one','Live','local','${at}','${at}','${at}','${at}',NULL),
      ('${deletedTaskId}','${spaceId}','one','DEV-2','one','Deleted','local','${at}','${at}','${at}','${at}','${at}'),
      ('${otherSpaceTaskId}','${otherSpaceId}','one','DEV-3','one','Other','local','${at}','${at}','${at}','${at}',NULL);
    SET ROLE record_actor;
  `)
})

afterAll(async () => {
  if (database) await database.close()
})

test('getHostedTask returns a live task in the space by record id and key', async () => {
  const client = pgliteSql(database)
  const identity = { userId, spaceId }

  expect((await getHostedTask(client, identity, liveTaskId))?.task.id).toBe(liveTaskId)
  expect((await getHostedTask(client, identity, 'DEV-1'))?.task.id).toBe(liveTaskId)
})

test('getHostedTask does not return a deleted task', async () => {
  const client = pgliteSql(database)
  const identity = { userId, spaceId }

  expect(await getHostedTask(client, identity, deletedTaskId)).toBeNull()
  expect(await getHostedTask(client, identity, 'DEV-2')).toBeNull()
})

test('getHostedTask does not return a task in another space', async () => {
  expect(await getHostedTask(pgliteSql(database), { userId, spaceId }, otherSpaceTaskId)).toBeNull()
})

test('createHostedTaskInTransaction mints a version-7 seq id', async () => {
  const client = pgliteSql(database)
  const identity = { userId, spaceId }

  await client.begin((tx) =>
    createHostedTaskInTransaction(tx, identity, {
      project: 'one',
      projectId,
      title: 'Mint seq id',
    }),
  )

  const rows = await client<{ id: string }[]>`
    SELECT id::text AS id FROM seq
    WHERE space_id=${spaceId}::uuid AND project_id=${projectId}::uuid AND name='task:DEV'`
  expect(rows[0]!.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
})
