import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
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

test('hosted inbox excludes answered and closed rows and pages in SQL', async () => {
  const page = await readRecordQuestionRows(pgliteSql(database), { read: 'inbox', limit: 1 })
  expect(page.items).toHaveLength(1)
  expect(page.items[0]?.number).toBe(1)
  expect(page.more).toBe(true)
})
