import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import {
  createHostedTaskInTransaction,
  getHostedTask,
  lookupHostedTasks,
  TASK_LOOKUP_KEY_LIMIT,
} from './hosted-tasks.ts'

const spaceId = '01990000-0000-7000-8000-000000001430'
const otherSpaceId = '01990000-0000-7000-8000-000000001431'
const userId = '01990000-0000-7000-8000-000000001432'
const liveTaskId = '01990000-0000-7000-8000-000000001433'
const deletedTaskId = '01990000-0000-7000-8000-000000001434'
const otherSpaceTaskId = '01990000-0000-7000-8000-000000001435'
const projectId = '01990000-0000-7000-8000-000000001436'
const parentTaskId = '01990000-0000-7000-8000-000000001437'
const childTaskId = '01990000-0000-7000-8000-000000001438'
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
    INSERT INTO hub_task
      (id,space_id,project_name,key,project,title,parent_key,parent_id,body,source,first_seen,last_seen,created_at,updated_at)
    VALUES
      ('${parentTaskId}','${spaceId}','one','DEV-4','one','Parent',NULL,NULL,'secret parent body','local','${at}','${at}','${at}','${at}'),
      ('${childTaskId}','${spaceId}','one','DEV-5','one','Child','DEV-4','${parentTaskId}','secret child body','local','${at}','${at}','${at}','${at}');
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

test('lookupHostedTasks returns requested tasks with ancestors and child presence only', async () => {
  const result = await lookupHostedTasks(pgliteSql(database), { userId, spaceId }, 'one', [
    'DEV-5',
    'DEV-404',
  ])
  expect(result.tasks.map(({ key }) => key)).toEqual(['DEV-4', 'DEV-5'])
  expect(result.tasks.find(({ key }) => key === 'DEV-4')?.has_children).toBe(true)
  expect(result.tasks.find(({ key }) => key === 'DEV-5')?.has_children).toBe(false)
  expect(result.tasks.every((row) => !('body' in row))).toBe(true)
  expect(Object.keys(result.tasks[0]!).sort()).toEqual(
    [
      'has_children',
      'key',
      'last_seen',
      'opened_at',
      'parent_key',
      'project',
      'record_id',
      'status',
      'status_category',
      'title',
    ].sort(),
  )
  expect(
    await lookupHostedTasks(pgliteSql(database), { userId, spaceId }, 'one', ['DEV-3']),
  ).toEqual({ tasks: [] })
  await expect(
    lookupHostedTasks(
      pgliteSql(database),
      { userId, spaceId },
      'one',
      Array.from({ length: TASK_LOOKUP_KEY_LIMIT + 1 }, (_, index) => `DEV-${index}`),
    ),
  ).rejects.toThrow(`at most ${TASK_LOOKUP_KEY_LIMIT}`)
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
