import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import { syncHostedRecord } from './record-sync-service.ts'

const actorUrl = process.env.BOTTEGA_RECORD_URL
const adminUrl = process.env.BOTTEGA_TEST_POSTGRES_URL
const realPostgres = actorUrl && adminUrl ? describe : describe.skip

const SPACE_ID = '01990000-0000-7000-8000-000000001771'
const USER_ID = '01990000-0000-7000-8000-000000001772'
const MEMBERSHIP_ID = '01990000-0000-7000-8000-000000001773'
const PROJECT_ID = '01990000-0000-7000-8000-000000001774'
const MACHINE_ID = '01990000-0000-7000-8000-000000001775'
const TASK_ID = '01990000-0000-7000-8000-000000001776'
const UNKNOWN_TASK_ID = '01990000-0000-7000-8000-000000001777'
const LINKED_RUN_ID = '01990000-0000-7000-8000-000000001778'
const UNKNOWN_RUN_ID = '01990000-0000-7000-8000-000000001779'
const STAMP = '2026-10-26T06:00:00.000Z'

function runPayload(id: string, taskId: string | null) {
  const payload = Object.fromEntries(
    OUTBOX_PAYLOAD_CONTRACTS.run.columns.map((column) => [column, null]),
  )
  return Object.assign(payload, {
    id,
    spaceId: SPACE_ID,
    projectId: PROJECT_ID,
    projectName: 'run-task-proof',
    machineId: MACHINE_ID,
    localId: 1,
    startedAt: STAMP,
    finishedAt: STAMP,
    agent: 'codex',
    job: 'implement',
    promptSha: 'prompt',
    promptBytes: 6,
    promptHead: 'prompt',
    taskKey: 'DEV-1771',
    taskId,
    probe: false,
    status: 'ok',
    turn: 1,
    noFailover: false,
    automaticFailover: false,
    workPreserved: false,
    createdAt: STAMP,
    updatedAt: STAMP,
  })
}

async function push(client: SQL, id: number, payload: Record<string, unknown>) {
  return syncHostedRecord({
    url: actorUrl!,
    postgres: client,
    identity: {
      user: { id: USER_ID },
      activeSpaceId: SPACE_ID,
      personalSpaceId: SPACE_ID,
      memberships: [{ space_id: SPACE_ID, slug: 'run-task-proof', permission: 'write' }],
    },
    request: {
      machine: { id: MACHINE_ID, name: 'run-task-proof', seenAt: STAMP },
      rows: [{ id, kind: 'run', payload: JSON.stringify(payload), spaceHint: null }],
    },
  })
}

realPostgres('hosted run task references', () => {
  test('sets a known task, preserves it when omitted, and clears an unknown task', async () => {
    const admin = new SQL(adminUrl!)
    const actor = new SQL(actorUrl!)
    try {
      await admin`INSERT INTO space (id,name,slug,created_at)
        VALUES (${SPACE_ID}::uuid,'Run task proof','run-task-proof',now())`
      await admin`INSERT INTO "user" (id,email,name,created_at)
        VALUES (${USER_ID}::uuid,'run-task-proof@example.test','Run Task Proof',now())`
      await admin`INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
        VALUES (${MEMBERSHIP_ID}::uuid,${SPACE_ID}::uuid,${USER_ID}::uuid,'member','write',now())`
      await admin`INSERT INTO project (id,space_id,name,key_prefixes,created_at)
        VALUES (${PROJECT_ID}::uuid,${SPACE_ID}::uuid,'run-task-proof',ARRAY['DEV'],now())`
      await admin`INSERT INTO hub_task
        (id,space_id,project_name,project_id,key,project,title,status,status_category,source,first_seen,last_seen,created_at,updated_at)
        VALUES (${TASK_ID}::uuid,${SPACE_ID}::uuid,'run-task-proof',${PROJECT_ID}::uuid,'DEV-1771','run-task-proof',
          'Run task proof','active','active','local',now(),now(),now(),now())`

      expect(await push(actor, 1, runPayload(LINKED_RUN_ID, TASK_ID))).toEqual({
        results: [{ id: 1, status: 'synced' }],
      })
      const omitted = runPayload(LINKED_RUN_ID, null)
      Reflect.deleteProperty(omitted, 'taskId')
      expect(await push(actor, 2, omitted)).toEqual({
        results: [{ id: 2, status: 'synced' }],
      })
      expect(await push(actor, 3, runPayload(UNKNOWN_RUN_ID, UNKNOWN_TASK_ID))).toEqual({
        results: [{ id: 3, status: 'synced' }],
      })

      const rows = await admin<{ id: string; task_id: string | null }[]>`
        SELECT id::text,task_id::text FROM run
        WHERE id IN (${LINKED_RUN_ID}::uuid,${UNKNOWN_RUN_ID}::uuid)
        ORDER BY id`
      expect([...rows]).toEqual([
        { id: LINKED_RUN_ID, task_id: TASK_ID },
        { id: UNKNOWN_RUN_ID, task_id: null },
      ])
    } finally {
      await admin`DELETE FROM run WHERE id IN (${LINKED_RUN_ID}::uuid,${UNKNOWN_RUN_ID}::uuid)`
      await admin`DELETE FROM hub_task WHERE id=${TASK_ID}::uuid`
      await admin`DELETE FROM project WHERE id=${PROJECT_ID}::uuid`
      await admin`DELETE FROM machine WHERE id=${MACHINE_ID}::uuid`
      await admin`DELETE FROM membership WHERE id=${MEMBERSHIP_ID}::uuid`
      await admin`DELETE FROM space WHERE id=${SPACE_ID}::uuid`
      await admin`DELETE FROM "user" WHERE id=${USER_ID}::uuid`
      await Promise.all([actor.close(), admin.close()])
    }
  })
})
