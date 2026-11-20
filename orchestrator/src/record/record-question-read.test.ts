import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import {
  decodeRecordChangeCursor,
  encodeRecordChangeCursor,
} from '../../../shared/record/record-changes.ts'
import { bindTenant } from '../../../shared/record/tenant.ts'
import { createHostedRecordFixture, pgliteSql } from '../../test/fixtures/hosted-record.ts'
import { installRecordPool } from '../../test/fixtures/record-pool-injection.ts'
import { readRecordQuestionRows, readRecordQuestions } from './record-question-read.ts'

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
const firstQuestionId = '01990000-0000-7000-8000-000000004024'
const secondQuestionId = '01990000-0000-7000-8000-000000004025'
const laterFirstQuestionId = '01990000-0000-7000-8000-000000004043'
const invisibleParentTurnId = '01990000-0000-7000-8000-000000004030'
const visibleParentId = '01990000-0000-7000-8000-000000004032'
const visibleParentTurnId = '01990000-0000-7000-8000-000000004033'
const unlinkedParentId = '01990000-0000-7000-8000-000000004034'
const linkedParentTurnId = '01990000-0000-7000-8000-000000004035'
const inheritedTaskKeyTurnId = '01990000-0000-7000-8000-000000004041'
const otherVisibleProjectId = '01990000-0000-7000-8000-000000004040'

let database: PGlite
const fixtureUrl = 'postgres://question-ruling-read.test/record'
let restorePool: (() => void) | undefined

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
    VALUES
      ('${secondProjectId}','${secondSpaceId}','second-question-project',ARRAY['TWO'],now()),
      ('${otherVisibleProjectId}','${spaceId}','other-question-project',ARRAY['ALT'],now());
    INSERT INTO run
      (id,space_id,machine_id,started_by_user_id,started_at,agent,job,prompt_sha,prompt_bytes,
       prompt_head,probe,project_id,status,turn,stack,model,executor,no_failover,
       automatic_failover,work_preserved,session_id,number,created_at,updated_at)
    VALUES
      ('${crossSpaceRunId}','${secondSpaceId}','${machineId}','${userId}',now(),'codex','implement',
       'sha-cross',1,'cross-space',false,'${secondProjectId}','asking',1,'typescript','test',
       'harness',false,false,true,'session-cross',3,now(),now());
    INSERT INTO run
      (id,space_id,machine_id,started_by_user_id,started_at,agent,job,prompt_sha,prompt_bytes,
       prompt_head,probe,project_id,status,turn,stack,model,executor,no_failover,
       automatic_failover,work_preserved,session_id,number,parent_run_id,created_at,updated_at)
    VALUES
      ('${invisibleParentTurnId}','${spaceId}','${machineId}','${userId}',now(),'codex','implement',
       'sha-invisible-parent',1,'invisible-parent-turn',false,'${projectId}','asking',2,
       'typescript','test','harness',false,false,true,'session-invisible-parent',4,
       '${crossSpaceRunId}',now(),now());
    UPDATE run SET task_id='${taskId}',task_key='DEV-1' WHERE id='${invisibleParentTurnId}';
    INSERT INTO run
      (id,space_id,machine_id,started_by_user_id,started_at,agent,job,prompt_sha,prompt_bytes,
       prompt_head,probe,project_id,task_id,task_key,status,turn,evidence_excluded,stack,model,
       executor,no_failover,automatic_failover,work_preserved,session_id,number,parent_run_id,
       created_at,updated_at)
    VALUES
      ('${visibleParentId}','${spaceId}','${machineId}','${userId}',now(),'codex','implement',
       'sha-visible-parent',1,'visible-parent',false,'${projectId}','${taskId}','DEV-1','done',1,
       NULL,'typescript','test','harness',false,false,true,'session-visible-parent',5,NULL,now(),now()),
      ('${visibleParentTurnId}','${spaceId}','${machineId}','${userId}',now(),'codex','implement',
       'sha-visible-turn',1,'visible-turn',false,'${otherVisibleProjectId}','${otherTaskId}','DEV-2','asking',2,
       'turn-only exclusion','typescript','test','harness',false,false,true,'session-visible-turn',6,
       '${visibleParentId}',now(),now()),
      ('${unlinkedParentId}','${spaceId}','${machineId}','${userId}',now(),'codex','implement',
       'sha-unlinked-parent',1,'unlinked-parent',false,'${projectId}',NULL,NULL,'done',1,NULL,
       'typescript','test','harness',false,false,true,'session-unlinked-parent',7,NULL,now(),now()),
      ('${linkedParentTurnId}','${spaceId}','${machineId}','${userId}',now(),'codex','implement',
       'sha-linked-turn',1,'linked-turn',false,'${projectId}','${taskId}','DEV-1','asking',2,NULL,
       'typescript','test','harness',false,false,true,'session-linked-turn',8,
       '${unlinkedParentId}',now(),now()),
      ('${inheritedTaskKeyTurnId}','${spaceId}','${machineId}','${userId}',now(),'codex','implement',
       'sha-inherited-task-key',1,'inherited-task-key',false,'${projectId}','${taskId}',NULL,'asking',2,NULL,
       'typescript','test','harness',false,false,true,'session-inherited-task-key',9,
       '${visibleParentId}',now(),now());
    INSERT INTO question
      (id,space_id,run_id,workflow_cursor_record_id,project_id,machine_id,number,revision,withheld_fields,
       asked_at,question,answer,answered_at,created_at,updated_at)
    VALUES
      ('${firstQuestionId}','${spaceId}','${crossSpaceRunId}','${firstCursorId}',
       '${projectId}','${machineId}',5,1,'[]','2026-11-17T12:00:00Z','cross-space owner',NULL,NULL,now(),now()),
      ('${secondQuestionId}','${secondSpaceId}','${crossSpaceRunId}','${secondCursorId}',
       '${secondProjectId}','${machineId}',6,1,'[]',now(),'second-space row',NULL,NULL,now(),now()),
      ('${laterFirstQuestionId}','${spaceId}','${secondRunId}','${firstCursorId}',
       '${projectId}','${machineId}',13,1,'[]','2026-11-17T13:00:00Z','later same-cursor row',NULL,NULL,now(),now()),
      ('01990000-0000-7000-8000-000000004031','${spaceId}','${invisibleParentTurnId}',NULL,
       '${projectId}','${machineId}',7,1,'[]',now(),'invisible parent root',NULL,NULL,now(),now()),
      ('01990000-0000-7000-8000-000000004036','${spaceId}','${visibleParentTurnId}',NULL,
       '${projectId}','${machineId}',8,1,'[]',now(),'visible parent inbox',NULL,NULL,now(),now()),
      ('01990000-0000-7000-8000-000000004037','${spaceId}','${visibleParentTurnId}',NULL,
       '${projectId}','${machineId}',9,1,'[]',now(),'visible parent ruling','yes',now(),now(),now()),
      ('01990000-0000-7000-8000-000000004038','${spaceId}','${linkedParentTurnId}',NULL,
       '${projectId}','${machineId}',10,1,'[]',now(),'unlinked parent ruling','yes',now(),now(),now()),
      ('01990000-0000-7000-8000-000000004039','${spaceId}','${invisibleParentTurnId}',NULL,
       '${projectId}','${machineId}',11,1,'[]',now(),'invisible parent ruling','yes',now(),now(),now()),
      ('01990000-0000-7000-8000-000000004042','${spaceId}','${inheritedTaskKeyTurnId}',NULL,
       '${projectId}','${machineId}',12,1,'[]',now(),'visible parent inherited task key',NULL,NULL,now(),now());
    SET ROLE record_actor;
  `)
  restorePool = installRecordPool(fixtureUrl, pgliteSql(database))
})

afterAll(async () => {
  restorePool?.()
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
    {
      record_id: firstQuestionId,
      workflow_cursor_record_id: firstCursorId,
      space_id: spaceId,
      number: 5,
    },
    {
      record_id: secondQuestionId,
      workflow_cursor_record_id: secondCursorId,
      space_id: secondSpaceId,
      number: 6,
    },
  ])
})

test('hosted inbox excludes answered and closed rows and pages in SQL', async () => {
  const page = await readRecordQuestionRows(pgliteSql(database), { read: 'inbox', limit: 1 })
  expect(page.items).toHaveLength(1)
  expect(page.items[0]?.number).toBe(1)
  expect(page.more).toBe(true)
})

test('hosted inbox excludes a turn whose parent run is not visible', async () => {
  const result = await readRecordQuestionRows(pgliteSql(database), { read: 'inbox' })
  expect(result.items.map((row) => row.question)).not.toContain('invisible parent root')
})

test('hosted inbox projects every root value from a visible parent', async () => {
  const result = await readRecordQuestionRows(pgliteSql(database), { read: 'inbox' })
  const row = result.items.find((item) => item.question === 'visible parent inbox')
  const inherited = result.items.find(
    (item) => item.question === 'visible parent inherited task key',
  )
  expect(row).toMatchObject({
    root_status: 'done',
    root_record_id: visibleParentId,
    root_number: 5,
    root_voided: 0,
    task_key: 'DEV-2',
    project_record_id: projectId,
    repo: 'question-read-fixture',
  })
  expect(inherited?.task_key).toBe('DEV-1')
})

test('hosted task rulings use the visible root task and exclude absent or invisible roots', async () => {
  const result = await readRecordQuestionRows(pgliteSql(database), {
    read: 'task-rulings',
    projectId,
    taskId,
  })
  expect(result.items.map((row) => row.question)).toEqual(['visible parent ruling'])
  expect(result.items[0]?.run_record_id).toBe(visibleParentId)
})

test('ruling bootstrap pages hand over their captured change head and replay drain changes', async () => {
  const first = await readRecordQuestions({
    url: fixtureUrl,
    userId,
    spaceId,
    read: 'rulings',
    kind: 'all',
    limit: 1,
  })
  expect(first.more).toBe(true)
  expect(first.cursor).toMatch(/^page:\d+:[^:]+$/)
  const [, firstNumber, encodedHead] = first.cursor!.split(':')
  const head = decodeRecordChangeCursor(encodedHead!)

  const drainQuestionId = '01990000-0000-7000-8000-000000004044'
  await database.exec(`
    RESET ROLE;
    INSERT INTO question
      (id,space_id,run_id,workflow_task_id,project_id,machine_id,number,revision,withheld_fields,
       asked_at,question,answer,answered_at,created_at,updated_at)
    VALUES
      ('${drainQuestionId}','${spaceId}','${firstRunId}','${taskId}','${projectId}','${machineId}',
       100,1,'[]',now(),'answered during drain','yes',now(),now(),now());
    SET ROLE record_actor;
  `)

  const final = await readRecordQuestions({
    url: fixtureUrl,
    userId,
    spaceId,
    read: 'rulings',
    kind: 'all',
    changedAfter: { questionNumber: Number(firstNumber), changeHead: head },
  })
  expect(final.more).toBe(false)
  expect(final.cursor).toBe(encodedHead)

  const replay = await readRecordQuestions({
    url: fixtureUrl,
    userId,
    spaceId,
    read: 'rulings',
    kind: 'all',
    changedAfter: head,
  })
  expect(replay.items.map((row) => row.record_id)).toContain(drainQuestionId)
})

test('resets and legacy page cursors restart a bounded bootstrap with a fresh head', async () => {
  const current = await readRecordQuestions({
    url: fixtureUrl,
    userId,
    spaceId,
    read: 'rulings',
    kind: 'all',
    limit: 1,
  })
  const encodedHead = current.cursor!.split(':').at(-1)!
  const head = decodeRecordChangeCursor(encodedHead)
  await database.exec(`
    RESET ROLE;
    UPDATE record_change_horizon
    SET xid='${head.xid.toString()}'::xid8,seq=${head.seq.toString()}
    WHERE singleton;
    SET ROLE record_actor;
  `)
  const reset = await readRecordQuestions({
    url: fixtureUrl,
    userId,
    spaceId,
    read: 'rulings',
    kind: 'all',
    changedAfter: { xid: 0n, seq: 0n },
  })
  expect(reset.reset).toBe(true)
  expect(reset.items.length).toBeLessThanOrEqual(100)
  expect(reset.cursor).toBeString()

  const legacy = await readRecordQuestions({
    url: fixtureUrl,
    userId,
    spaceId,
    read: 'rulings',
    kind: 'all',
    changedAfter: { questionNumber: 1 },
  })
  expect(legacy.reset).toBe(true)
  expect(legacy.items[0]?.number).toBe(1)
  expect(decodeRecordChangeCursor(legacy.cursor!)).toEqual(head)
  expect(encodeRecordChangeCursor(head)).toBe(encodedHead)
})

test('a bootstrap handover head never falls behind the prune horizon', async () => {
  const current = await readRecordQuestions({
    url: fixtureUrl,
    userId,
    spaceId,
    read: 'rulings',
    kind: 'all',
    limit: 1,
  })
  const currentHead = decodeRecordChangeCursor(current.cursor!.split(':').at(-1)!)
  const horizon = { xid: currentHead.xid + 100n, seq: currentHead.seq }
  await database.exec(`
    RESET ROLE;
    UPDATE record_change_horizon
    SET xid='${horizon.xid.toString()}'::xid8,seq=${horizon.seq.toString()}
    WHERE singleton;
    SET ROLE record_actor;
  `)

  const bootstrap = await readRecordQuestions({
    url: fixtureUrl,
    userId,
    spaceId,
    read: 'rulings',
    kind: 'all',
    limit: 1,
  })
  expect(decodeRecordChangeCursor(bootstrap.cursor!.split(':').at(-1)!)).toEqual(horizon)
})
