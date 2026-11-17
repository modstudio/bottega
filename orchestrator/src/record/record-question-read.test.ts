import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { bindTenant } from '../../../shared/record/tenant.ts'
import { createHostedRecordFixture, pgliteSql } from '../../test/fixtures/hosted-record.ts'
import { readRecordQuestionRows } from './record-question-read.ts'

const spaceId = '01990000-0000-7000-8000-000000004001'
const userId = '01990000-0000-7000-8000-000000004002'
const projectId = '01990000-0000-7000-8000-000000004003'
const machineId = '01990000-0000-7000-8000-000000004004'
const taskId = '01990000-0000-7000-8000-000000004005'
const otherTaskId = '01990000-0000-7000-8000-000000004006'
const firstRunId = '01990000-0000-7000-8000-000000004007'
const secondRunId = '01990000-0000-7000-8000-000000004008'
const secondSpaceId = '01990000-0000-7000-8000-000000004020'
const secondProjectId = '01990000-0000-7000-8000-000000004021'
const crossSpaceRunId = '01990000-0000-7000-8000-000000004022'
const firstSpaceOnlyUserId = '01990000-0000-7000-8000-000000004026'
const firstCursorId = '01990000-0000-7000-8000-000000004028'
const secondCursorId = '01990000-0000-7000-8000-000000004029'

let database: PGlite

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
  await database.exec(`
    RESET ROLE;
    INSERT INTO project (id,space_id,name,key_prefixes,created_at)
    VALUES ('${projectId}','${spaceId}','question-read-fixture',ARRAY['DEV'],now());
    INSERT INTO machine (id,user_id,name,registered_at,last_seen)
    VALUES ('${machineId}','${userId}','question-read-machine',now(),now());
    INSERT INTO hub_task
      (id,space_id,project_name,project_id,key,project,title,status,status_category,source,
       first_seen,last_seen,created_at,updated_at)
    VALUES
      ('${taskId}','${spaceId}','question-read-fixture','${projectId}','DEV-1','question-read-fixture',
       'First','active','active','local',now(),now(),now(),now()),
      ('${otherTaskId}','${spaceId}','question-read-fixture','${projectId}','DEV-2','question-read-fixture',
       'Second','active','active','local',now(),now(),now(),now());
    INSERT INTO run
      (id,space_id,machine_id,started_by_user_id,started_at,agent,job,prompt_sha,prompt_bytes,
       prompt_head,probe,project_id,status,turn,stack,model,executor,no_failover,
       automatic_failover,work_preserved,session_id,number,created_at,updated_at)
    VALUES
      ('${firstRunId}','${spaceId}','${machineId}','${userId}',now(),'codex','implement','sha-1',1,
       'first',false,'${projectId}','asking',1,'typescript','test','harness',false,false,true,
       'session-a',1,now(),now()),
      ('${secondRunId}','${spaceId}','${machineId}','${userId}',now(),'codex','implement','sha-2',1,
       'second',false,'${projectId}','asking',1,'typescript','test','harness',false,false,true,
       'session-b',2,now(),now());
    INSERT INTO question
      (id,space_id,run_id,workflow_task_id,project_id,machine_id,number,revision,withheld_fields,
       asked_at,question,answer,answered_at,closed_at,created_at,updated_at)
    VALUES
      ('01990000-0000-7000-8000-000000004011','${spaceId}','${firstRunId}','${taskId}',
       '${projectId}','${machineId}',1,1,'[]',now(),'open first',NULL,NULL,NULL,now(),now()),
      ('01990000-0000-7000-8000-000000004012','${spaceId}','${firstRunId}','${taskId}',
       '${projectId}','${machineId}',2,1,'[]',now(),'answered first','yes',now(),NULL,now(),now()),
      ('01990000-0000-7000-8000-000000004013','${spaceId}','${secondRunId}','${taskId}',
       '${projectId}','${machineId}',3,1,'[]',now(),'closed second',NULL,NULL,now(),now(),now()),
      ('01990000-0000-7000-8000-000000004014','${spaceId}','${secondRunId}','${otherTaskId}',
       '${projectId}','${machineId}',4,1,'[]',now(),'open second',NULL,NULL,NULL,now(),now());
    INSERT INTO space (id,name,slug,created_at)
    VALUES ('${secondSpaceId}','Second question space','second-question-space',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
    VALUES ('01990000-0000-7000-8000-000000004023','${secondSpaceId}','${userId}','member','write',now());
    INSERT INTO "user" (id,email,name,created_at)
    VALUES ('${firstSpaceOnlyUserId}','first-space@example.test','First space user',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
    VALUES ('01990000-0000-7000-8000-000000004027','${spaceId}','${firstSpaceOnlyUserId}',
      'member','read',now());
    INSERT INTO project (id,space_id,name,key_prefixes,created_at)
    VALUES ('${secondProjectId}','${secondSpaceId}','second-question-project',ARRAY['TWO'],now());
    INSERT INTO run
      (id,space_id,machine_id,started_by_user_id,started_at,agent,job,prompt_sha,prompt_bytes,
       prompt_head,probe,project_id,status,turn,stack,model,executor,no_failover,
       automatic_failover,work_preserved,session_id,number,created_at,updated_at)
    VALUES
      ('${crossSpaceRunId}','${secondSpaceId}','${machineId}','${userId}',now(),'codex','implement',
       'sha-cross',1,'cross-space',false,'${secondProjectId}','asking',1,'typescript','test',
       'harness',false,false,true,'session-cross',3,now(),now());
    INSERT INTO question
      (id,space_id,run_id,workflow_cursor_record_id,project_id,machine_id,number,revision,withheld_fields,
       asked_at,question,created_at,updated_at)
    VALUES
      ('01990000-0000-7000-8000-000000004024','${spaceId}','${crossSpaceRunId}','${firstCursorId}',
       '${projectId}','${machineId}',5,1,'[]',now(),'cross-space owner',now(),now()),
      ('01990000-0000-7000-8000-000000004025','${secondSpaceId}','${crossSpaceRunId}','${secondCursorId}',
       '${secondProjectId}','${machineId}',6,1,'[]',now(),'second-space row',now(),now());
    SET ROLE record_actor;
  `)
})

afterAll(async () => {
  if (database) await database.close()
})

test('hosted targeted question reads enforce run, task, and session scope', async () => {
  const sql = pgliteSql(database)
  const runs = await readRecordQuestionRows(sql, { read: 'for-runs', runIds: [firstRunId] })
  expect(runs.items.map((row) => row.number)).toEqual([1, 2])

  const tasks = await readRecordQuestionRows(sql, {
    read: 'open-for-tasks',
    taskRecordIds: [taskId],
  })
  expect(tasks.items.map((row) => row.number)).toEqual([1])

  const session = await readRecordQuestionRows(sql, {
    read: 'for-session',
    sessionId: 'session-a',
  })
  expect(session.items.map((row) => row.number)).toEqual([1, 2])
})

async function questionsForCrossSpaceRun(spaceIds: string[], principalUserId = userId) {
  const sql = pgliteSql(database)
  return sql.begin(async (tx) => {
    await bindTenant(tx, { userId: principalUserId, spaceId, spaceIds })
    return readRecordQuestionRows(tx, { read: 'for-run', runId: crossSpaceRunId })
  })
}

test('a keyed run read returns rows from every bound member space with their home spaces', async () => {
  const result = await questionsForCrossSpaceRun([spaceId, secondSpaceId])
  expect(result.items.map((row) => [row.number, row.space_id, row.run_number])).toEqual([
    [5, spaceId, 3],
    [6, secondSpaceId, 3],
  ])
})

test('a keyed run read never returns a row from an unbound space', async () => {
  const result = await questionsForCrossSpaceRun([spaceId], firstSpaceOnlyUserId)
  expect(result.items.map((row) => [row.number, row.space_id])).toEqual([[5, spaceId]])
})

test('open-for-cursors returns one home-space row for each cursor across bound spaces', async () => {
  const sql = pgliteSql(database)
  const result = await sql.begin(async (tx) => {
    await bindTenant(tx, { userId, spaceId, spaceIds: [spaceId, secondSpaceId] })
    return readRecordQuestionRows(tx, {
      read: 'open-for-cursors',
      workflowCursorRecordIds: [firstCursorId, secondCursorId],
    })
  })
  expect(result.items).toEqual([
    { workflow_cursor_record_id: firstCursorId, space_id: spaceId, number: 5 },
    { workflow_cursor_record_id: secondCursorId, space_id: secondSpaceId, number: 6 },
  ])
})

test('hosted inbox excludes answered and closed rows and pages in SQL', async () => {
  const page = await readRecordQuestionRows(pgliteSql(database), { read: 'inbox', limit: 1 })
  expect(page.items).toHaveLength(1)
  expect(page.items[0]?.number).toBe(1)
  expect(page.more).toBe(true)
})
