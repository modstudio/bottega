import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { RECORD_ACTOR_ROLE } from '../../shared/record/schema.ts'
import { bindTenant } from '../../shared/record/tenant.ts'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { applyIntervalChangeInTransaction } from './hosted-evidence.ts'
import { storedHubProjectId } from './hosted-project-identity.ts'
import { applyHostedPushChangesInTransaction } from './hosted-push-changes.ts'
import { mirrorTaskRow } from './hosted-tasks.ts'
import type { HostedPushChange, PushedTask } from './push-contract.ts'

const spaceId = '01990000-0000-7000-8000-000000001250'
const userId = '01990000-0000-7000-8000-000000001249'
const projectId = '01990000-0000-7000-8000-000000001260'
const identity = { userId, spaceId }
let database: PGlite

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
  await database.exec(`
    INSERT INTO project (id, space_id, name, created_at)
    VALUES ('${projectId}', '${spaceId}', 'workshop', now());
  `)
})

afterAll(async () => {
  await database?.close()
})

test('hosted write stores a sent projectId and resolves an absent one by name', async () => {
  const tx = pgliteSql(database)
  await bindTenant(tx, identity)
  await expect(storedHubProjectId(tx, spaceId, { projectId, projectName: 'stale' })).resolves.toBe(
    projectId,
  )
  await expect(storedHubProjectId(tx, spaceId, { projectName: 'workshop' })).resolves.toBe(
    projectId,
  )
  await expect(storedHubProjectId(tx, spaceId, { projectName: 'missing' })).resolves.toBeNull()
  const sentId = '01990000-0000-7000-8000-000000001261'
  await applyIntervalChangeInTransaction(tx, identity, {
    id: sentId,
    op: 'upsert',
    row: {
      id: sentId,
      task_key: null,
      project_name: 'stale',
      projectId,
      source: 'orch',
      agent: null,
      job: null,
      start_at: '2026-10-15T12:00:00.000Z',
      end_at: '2026-10-15T12:01:00.000Z',
      claude_tokens: 0,
      vendor_tokens: 0,
      vendor_cost_usd: null,
      ref: 'orch:identity:sent',
      via: null,
      open: 0,
      session_id: null,
      user_id: null,
    },
  })
  const namedId = '01990000-0000-7000-8000-000000001262'
  await applyIntervalChangeInTransaction(tx, identity, {
    id: namedId,
    op: 'upsert',
    row: {
      id: namedId,
      task_key: null,
      project_name: 'workshop',
      source: 'orch',
      agent: null,
      job: null,
      start_at: '2026-10-15T12:02:00.000Z',
      end_at: '2026-10-15T12:03:00.000Z',
      claude_tokens: 0,
      vendor_tokens: 0,
      vendor_cost_usd: null,
      ref: 'orch:identity:named',
      via: null,
      open: 0,
      session_id: null,
      user_id: null,
    },
  })
  const stored = await tx<{ id: string; project_id: string }[]>`
    SELECT id::text AS id, project_id::text AS project_id FROM hub_interval
    WHERE id IN (${sentId}::uuid, ${namedId}::uuid) ORDER BY start_at`
  expect(stored).toEqual([
    { id: sentId, project_id: projectId },
    { id: namedId, project_id: projectId },
  ])
})

test('a supplied projectId unknown or from another space refuses the write', async () => {
  const unknownId = '01990000-0000-7000-8000-000000001298'
  const foreignId = '01990000-0000-7000-8000-000000001297'
  const foreignSpace = '01990000-0000-7000-8000-000000001296'
  await database.exec(`
    RESET ROLE;
    INSERT INTO space(id,name,slug,created_at)
    VALUES ('${foreignSpace}','Foreign identity space','foreign-identity-space',now());
    INSERT INTO project (id, space_id, name, created_at)
    VALUES ('${foreignId}', '${foreignSpace}', 'elsewhere', now());
    SET ROLE ${RECORD_ACTOR_ROLE};
  `)
  const tx = pgliteSql(database)
  await bindTenant(tx, identity)
  await expect(storedHubProjectId(tx, spaceId, { projectId: unknownId })).rejects.toThrow(
    `record project ${unknownId} is absent from request space ${spaceId}`,
  )
  await expect(storedHubProjectId(tx, spaceId, { projectId: foreignId })).rejects.toThrow(
    `record project ${foreignId} is absent from request space ${spaceId}`,
  )
  await expect(storedHubProjectId(tx, spaceId, { projectName: 'missing' })).resolves.toBeNull()
})

const at = '2026-10-15T13:00:00.000Z'
const taskId = '01990000-0000-7000-8000-000000001270'
const intervalId = '01990000-0000-7000-8000-000000001271'
const noteId = '01990000-0000-7000-8000-000000001272'
const ackId = '01990000-0000-7000-8000-000000001273'

const taskRow = (): PushedTask => ({
  id: taskId,
  key: 'DEV-IDENTITY',
  project: 'workshop',
  project_name: 'workshop',
  projectId,
  title: 'Identity',
  status: 'active',
  status_category: 'active',
  parent_key: null,
  parent_id: null,
  body: null,
  assignee: null,
  opened_at: at,
  closed_at: null,
  source: 'mcp',
  first_seen: at,
  last_seen: at,
  created_at: at,
  updated_at: at,
  deleted_at: null,
  next_document_number: 1,
})

const applyPush = (inputs: HostedPushChange[]) =>
  database.transaction(async (transaction) => {
    const sql = pgliteSql(transaction as unknown as PGlite)
    sql.unsafe = (async (statement: string) =>
      (await transaction.query(statement)).rows) as SQL['unsafe']
    return applyHostedPushChangesInTransaction(sql, identity, inputs)
  })

test('a later write stores projectId on an otherwise identical null-identity row', async () => {
  const tx = pgliteSql(database)
  await bindTenant(tx, identity)
  const task = taskRow()
  await tx`INSERT INTO hub_task
    (id,space_id,project_name,project_id,key,project,title,status,status_category,parent_key,body,assignee,
     opened_at,closed_at,source,first_seen,last_seen,created_at,updated_at,deleted_at,next_document_number)
    VALUES (${taskId}::uuid,${spaceId}::uuid,'workshop',NULL,'DEV-IDENTITY','workshop','Identity','active','active',
     NULL,NULL,NULL,${at}::timestamptz,NULL,'mcp',${at}::timestamptz,${at}::timestamptz,${at}::timestamptz,
     ${at}::timestamptz,NULL,1)`
  await mirrorTaskRow(tx, identity, task)
  await tx`INSERT INTO hub_interval
    (id,space_id,task_key,project_name,project_id,source,agent,job,start_at,end_at,claude_tokens,vendor_tokens,
     vendor_cost_usd,ref,via,open,session_id,user_id,updated_at)
    VALUES (${intervalId}::uuid,${spaceId}::uuid,NULL,'workshop',NULL,'orch',NULL,NULL,${at}::timestamptz,
     ${'2026-10-15T13:01:00.000Z'}::timestamptz,0,0,NULL,'orch:identity:null',NULL,0,NULL,NULL,now())`
  await applyIntervalChangeInTransaction(tx, identity, {
    id: intervalId,
    op: 'upsert',
    row: {
      id: intervalId,
      task_key: null,
      project_name: 'workshop',
      projectId,
      source: 'orch',
      agent: null,
      job: null,
      start_at: at,
      end_at: '2026-10-15T13:01:00.000Z',
      claude_tokens: 0,
      vendor_tokens: 0,
      vendor_cost_usd: null,
      ref: 'orch:identity:null',
      via: null,
      open: 0,
      session_id: null,
      user_id: null,
    },
  })
  await tx`INSERT INTO hub_note
    (id,space_id,project_name,project_id,number,project,text,anchors,sightings,created_at,last_seen_at,updated_at)
    VALUES (${noteId}::uuid,${spaceId}::uuid,'workshop',NULL,1,'workshop','text','[]',1,${at}::timestamptz,
     ${at}::timestamptz,${at}::timestamptz)`
  await tx`INSERT INTO hub_note_acknowledgement
    (id,space_id,project_name,project_id,note_id,session_id,acknowledged_at,sightings,created_at,updated_at)
    VALUES (${ackId}::uuid,${spaceId}::uuid,'workshop',NULL,${noteId}::uuid,'sess-identity',${at}::timestamptz,
     1,${at}::timestamptz,${at}::timestamptz)`
  expect(
    await applyPush([
      {
        table: 'hub_note_acknowledgement',
        id: ackId,
        op: 'upsert',
        row: {
          id: ackId,
          project_name: 'workshop',
          projectId,
          note_id: noteId,
          session_id: 'sess-identity',
          acknowledged_at: at,
          sightings: 1,
          created_at: at,
          updated_at: at,
          deleted_at: null,
        },
      },
    ]),
  ).toEqual([{ id: ackId, status: 'applied' }])
  const stored = await tx<{ table: string; project_id: string }[]>`
    SELECT 'task' AS table, project_id::text AS project_id FROM hub_task WHERE id=${taskId}::uuid
    UNION ALL
    SELECT 'interval', project_id::text FROM hub_interval WHERE id=${intervalId}::uuid
    UNION ALL
    SELECT 'ack', project_id::text FROM hub_note_acknowledgement WHERE id=${ackId}::uuid
    ORDER BY 1`
  expect(stored).toEqual([
    { table: 'ack', project_id: projectId },
    { table: 'interval', project_id: projectId },
    { table: 'task', project_id: projectId },
  ])
})
