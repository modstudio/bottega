import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { type RecordChangeEntry, readRecordChanges } from '../../../shared/record/record-changes.ts'
import { createHostedRecordFixture, pgliteSql } from '../../test/fixtures/hosted-record.ts'
import { familyKeys, materializeRecordChangePage } from './record-change-feed.ts'
import { recordDocRow } from './record-doc-mapping.ts'
import { recordDocRows } from './record-doc-read.ts'
import { mapRecordPortRow, recordPortRows } from './record-port-catalogue.ts'
import { mapRecordProjectRow, recordProjectRows } from './record-projects.ts'
import {
  mapRecordRoutingEvidenceRow,
  recordRoutingEvidenceRows,
} from './record-routing-evidence.ts'
import { mapRecordScoreRow, recordScoreRows } from './record-verdicts.ts'

const spaceId = '01990000-0000-7000-8000-000000002100'
const userId = '01990000-0000-7000-8000-000000002101'
const projectId = '01990000-0000-7000-8000-000000002102'
const docId = '01990000-0000-7000-8000-000000002103'
const relatedSubjectId = '01990000-0000-7000-8000-000000002104'
const deletedSubjectId = '01990000-0000-7000-8000-000000002105'
const relationId = '01990000-0000-7000-8000-000000002106'
const doctrineId = '01990000-0000-7000-8000-000000002107'
const excludedRunId = '01990000-0000-7000-8000-000000002108'
const secondDocId = '01990000-0000-7000-8000-000000002109'
const machineId = '01990000-0000-7000-8000-000000002110'
const scoredRunId = '01990000-0000-7000-8000-000000002111'
const memberSpaceId = '01990000-0000-7000-8000-000000002112'
const outsiderSpaceId = '01990000-0000-7000-8000-000000002113'
const memberProjectId = '01990000-0000-7000-8000-000000002114'
const outsiderProjectId = '01990000-0000-7000-8000-000000002115'
const memberMembershipId = '01990000-0000-7000-8000-000000002116'
const reviewId = '01990000-0000-7000-8000-000000002117'
const reviewLensId = '01990000-0000-7000-8000-000000002118'
const movedSpaceId = '01990000-0000-7000-8000-000000002119'
const movedMembershipId = '01990000-0000-7000-8000-000000002120'
const movedDocId = '01990000-0000-7000-8000-000000002121'

const change = (
  table: string,
  id: string,
  position: number,
  op: 'upsert' | 'delete' = 'upsert',
): RecordChangeEntry => ({ xid: 1n, seq: BigInt(position + 1), table, id, space: spaceId, op })

test('family keys map aliases, skip unserved tables, and keep each family id at its last position', () => {
  expect(
    familyKeys([
      change('doc', 'doc-1', 0),
      change('run', 'run-1', 1, 'delete'),
      change('hub_task', 'hub-1', 2),
      change('run_score', 'score-1', 3, 'delete'),
      change('project', 'project-1', 4),
      change('doc', 'doc-1', 5, 'delete'),
      change('run', 'run-1', 6),
    ]),
  ).toEqual([
    {
      table: 'run_score',
      id: 'score-1',
      space: spaceId,
      op: 'delete',
      position: 3,
    },
    {
      table: 'routing_evidence',
      id: 'score-1',
      space: spaceId,
      op: 'upsert',
      position: 3,
    },
    {
      table: 'project',
      id: 'project-1',
      space: spaceId,
      op: 'upsert',
      position: 4,
    },
    { table: 'doc', id: 'doc-1', space: spaceId, op: 'delete', position: 5 },
    {
      table: 'routing_evidence',
      id: 'run-1',
      space: spaceId,
      op: 'upsert',
      position: 6,
    },
    { table: 'run_score', id: 'run-1', space: spaceId, op: 'upsert', position: 6 },
  ])
})

let database: PGlite

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
})

afterAll(async () => {
  if (database) await database.close()
})

test('record changes read every member space and exclude a non-member space', async () => {
  await database.exec(`
    RESET ROLE;
    INSERT INTO space (id,name,slug,created_at) VALUES
      ('${memberSpaceId}','Feed member space','feed-member-space',now()),
      ('${outsiderSpaceId}','Feed outsider space','feed-outsider-space',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
    VALUES ('${memberMembershipId}','${memberSpaceId}','${userId}','member','write',now());
    INSERT INTO project (id,space_id,name,key_prefixes,created_at) VALUES
      ('${memberProjectId}','${memberSpaceId}','member-project',ARRAY['MEMBER'],now()),
      ('${outsiderProjectId}','${outsiderSpaceId}','outsider-project',ARRAY['OUT'],now());
    SET ROLE record_actor;
  `)
  const feed = await readRecordChanges(
    pgliteSql(database),
    { userId, spaceId, spaceIds: [spaceId, memberSpaceId] },
    { xid: 0n, seq: 0n },
    100,
    ['project'],
  )
  expect(feed.resetRequired).toBe(false)
  if (feed.resetRequired) return
  expect(feed.changes.some((entry) => entry.id === memberProjectId)).toBe(true)
  expect(feed.changes.some((entry) => entry.id === outsiderProjectId)).toBe(false)
})

test('moving a document logs a delete in its old space and an upsert in its new space', async () => {
  const movedDatabase = await createHostedRecordFixture({ spaceId, userId })
  await movedDatabase.exec(`
    RESET ROLE;
    INSERT INTO space (id,name,slug,created_at)
    VALUES ('${movedSpaceId}','Moved document space','moved-document-space',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
    VALUES ('${movedMembershipId}','${movedSpaceId}','${userId}','member','write',now());
    INSERT INTO doc (
      id,space_id,scope,subject,slug,title,body,delivery,audiences,created_at,updated_at
    ) VALUES (
      '${movedDocId}','${spaceId}','global',NULL,'moved-doc','Moved doc','Body','demand',
      ARRAY['technical'],now(),now()
    );
    UPDATE doc SET space_id='${movedSpaceId}' WHERE id='${movedDocId}';
    SET ROLE record_actor;
  `)
  const changes = await readRecordChanges(
    pgliteSql(movedDatabase),
    { userId, spaceId, spaceIds: [spaceId, movedSpaceId] },
    { xid: 0n, seq: 0n },
    100,
    ['doc'],
  )
  expect(changes.resetRequired).toBe(false)
  if (changes.resetRequired) return
  expect(
    changes.changes
      .filter((entry) => entry.id === movedDocId)
      .map(({ space, op }) => ({ space, op })),
  ).toEqual([
    { space: spaceId, op: 'upsert' },
    { space: spaceId, op: 'delete' },
    { space: movedSpaceId, op: 'upsert' },
  ])
  await movedDatabase.close()
})

test('materialized changes reuse pull rows and preserve child mappings and tombstones', async () => {
  await database.exec(`
    INSERT INTO project (id,space_id,name,key_prefixes,created_at)
    VALUES ('${projectId}','${spaceId}','feed-project',ARRAY['FEED'],now());
    INSERT INTO doc (
      id,space_id,scope,subject,slug,title,body,delivery,audiences,project_id,created_at,updated_at
    ) VALUES (
      '${docId}','${spaceId}','project','feed-project','feed-doc','Feed doc','Body','demand',
      ARRAY['technical'],'${projectId}',now(),now()
    ), (
      '${secondDocId}','${spaceId}','project','feed-project','feed-doc-two','Feed doc two','Body two','demand',
      ARRAY['technical'],'${projectId}',now(),now()
    );
    INSERT INTO subject (id,space_id,project_id,name,definition,position,created_at,updated_at)
    VALUES
      ('${relatedSubjectId}','${spaceId}','${projectId}','Related','Related definition',0,now(),now()),
      ('${deletedSubjectId}','${spaceId}','${projectId}','Deleted','Deleted definition',1,now(),now());
    INSERT INTO doc_related_subject (id,space_id,doc_id,subject_id)
    VALUES ('${relationId}','${spaceId}','${docId}','${relatedSubjectId}');
    UPDATE doc_related_subject SET doc_id='${secondDocId}' WHERE id='${relationId}';
    INSERT INTO port_doctrine (id,space_id,number,title,body,created_at)
    VALUES ('${doctrineId}','${spaceId}',1,'Feed doctrine','Feed body',now());
    DELETE FROM subject WHERE id='${deletedSubjectId}';
    INSERT INTO run_exclusion (run_id,space_id,reason,excluded_at)
    VALUES ('${excludedRunId}','${spaceId}','excluded from evidence',now());
    INSERT INTO machine (id,user_id,name,registered_at,last_seen)
    VALUES ('${machineId}','${userId}','feed-machine',now(),now());
    INSERT INTO run (
      id,space_id,machine_id,started_by_user_id,started_at,agent,job,prompt_sha,prompt_bytes,
      prompt_head,probe,project_id,status,turn,stack,model,executor,no_failover,
      automatic_failover,work_preserved,created_at,updated_at
    ) VALUES (
      '${scoredRunId}','${spaceId}','${machineId}','${userId}',now(),'feed-agent','implement',
      'feed-sha',123,'feed prompt',false,'${projectId}','ok',1,'typescript','feed-model',
      'harness',false,false,true,now(),now()
    );
    INSERT INTO run_score (
      run_id,space_id,delivery,quality,fidelity,scored_at,scored_by,updated_at
    ) VALUES (
      '${scoredRunId}','${spaceId}','full','right','faithful',now(),'architect',now()
    );
  `)

  const sql = pgliteSql(database)
  const feed = await readRecordChanges(
    sql,
    { userId, spaceId, spaceIds: [spaceId] },
    { xid: 0n, seq: 0n },
    200,
    ['doc', 'subject', 'project', 'port_doctrine', 'run'],
    async (tx, page) => (page.resetRequired ? page : materializeRecordChangePage(tx, page)),
  )
  expect(feed.resetRequired).toBe(false)
  if (feed.resetRequired) return

  const docPull = recordDocRow((await recordDocRows(sql, { ids: [docId] }))[0]!)
  const projectPull = mapRecordProjectRow((await recordProjectRows(sql, [projectId]))[0]!)
  const doctrinePull = mapRecordPortRow(
    'port_doctrine',
    (await recordPortRows(sql, 'port_doctrine', { ids: [doctrineId] }))[0]!,
  )
  expect(feed.changes.find((entry) => entry.table === 'doc')?.row).toEqual(docPull)
  expect(feed.changes.find((entry) => entry.table === 'project')?.row).toEqual(projectPull)
  expect(feed.changes.find((entry) => entry.table === 'port_doctrine')?.row).toEqual(doctrinePull)
  expect(feed.changes.find((entry) => entry.id === deletedSubjectId)).toEqual({
    table: 'subject',
    id: deletedSubjectId,
    space: spaceId,
    op: 'delete',
  })
  const firstDoc = feed.changes.find((entry) => entry.table === 'doc' && entry.id === docId)
  const secondDoc = feed.changes.find((entry) => entry.table === 'doc' && entry.id === secondDocId)
  expect(firstDoc).toMatchObject({ table: 'doc', id: docId, op: 'upsert' })
  expect(secondDoc).toMatchObject({ table: 'doc', id: secondDocId, op: 'upsert' })
  if (!firstDoc || !secondDoc) throw new Error('re-pointed document changes are missing')
  expect((firstDoc.row as { relatedSubjects: unknown[] }).relatedSubjects).toEqual([])
  expect((secondDoc.row as { relatedSubjects: unknown[] }).relatedSubjects).toEqual([
    { id: relatedSubjectId, name: 'Related' },
  ])

  const excludedScore = mapRecordScoreRow(
    (await recordScoreRows(sql, { ids: [excludedRunId] }))[0]!,
  )
  expect(feed.changes.filter((entry) => entry.id === excludedRunId)).toEqual([
    { table: 'routing_evidence', id: excludedRunId, space: spaceId, op: 'delete' },
    { table: 'run_score', id: excludedRunId, space: spaceId, op: 'upsert', row: excludedScore },
  ])

  const { evidenceSequence: _routingCursor, ...routingPull } = mapRecordRoutingEvidenceRow(
    (await recordRoutingEvidenceRows(sql, { ids: [scoredRunId] }))[0]!,
  )
  const scorePull = mapRecordScoreRow((await recordScoreRows(sql, { ids: [scoredRunId] }))[0]!)
  const scoredChanges = feed.changes.filter((entry) => entry.id === scoredRunId)
  expect(scoredChanges).toHaveLength(2)
  expect(scoredChanges).toEqual(
    expect.arrayContaining([
      {
        table: 'run_score',
        id: scoredRunId,
        space: spaceId,
        op: 'upsert',
        row: scorePull,
      },
      {
        table: 'routing_evidence',
        id: scoredRunId,
        space: spaceId,
        op: 'upsert',
        row: routingPull,
      },
    ]),
  )

  await database.exec(`DELETE FROM doc_related_subject WHERE id='${relationId}'`)
  const afterRelationDelete = await readRecordChanges(
    sql,
    { userId, spaceId, spaceIds: [spaceId] },
    feed.cursor,
    100,
    ['doc'],
    async (tx, page) => (page.resetRequired ? page : materializeRecordChangePage(tx, page)),
  )
  expect(afterRelationDelete.resetRequired).toBe(false)
  if (afterRelationDelete.resetRequired) return
  const deletedRelationDoc = afterRelationDelete.changes.find(
    (entry) => entry.table === 'doc' && entry.id === secondDocId,
  )
  expect(deletedRelationDoc).toMatchObject({ table: 'doc', id: secondDocId, op: 'upsert' })
  expect(deletedRelationDoc).toHaveProperty('row')
  if (!deletedRelationDoc) throw new Error('deleted relation document change is missing')
  expect((deletedRelationDoc.row as { relatedSubjects: unknown[] }).relatedSubjects).toEqual([])

  await database.exec(`
    INSERT INTO review_lens (
      id,space_id,review_id,run_id,machine_id,lens,agent,standards_read,files_covered,
      commands_run,could_not_verify,mcp_tools,docs_read,substitutes,created_at,updated_at
    ) VALUES (
      '${reviewLensId}','${spaceId}','${reviewId}','${scoredRunId}','${machineId}',
      'feed-review-lens','feed-reviewer','[]','[]','[]','[]','[]','[]','[]',now(),now()
    )
  `)
  const afterReviewLens = await readRecordChanges(
    sql,
    { userId, spaceId, spaceIds: [spaceId] },
    afterRelationDelete.cursor,
    100,
    ['run'],
    async (tx, page) => (page.resetRequired ? page : materializeRecordChangePage(tx, page)),
  )
  expect(afterReviewLens.resetRequired).toBe(false)
  if (afterReviewLens.resetRequired) return
  const { evidenceSequence: _routingAfterLensCursor, ...routingAfterLens } =
    mapRecordRoutingEvidenceRow((await recordRoutingEvidenceRows(sql, { ids: [scoredRunId] }))[0]!)
  const scoreAfterLens = mapRecordScoreRow((await recordScoreRows(sql, { ids: [scoredRunId] }))[0]!)
  expect(afterReviewLens.changes).toEqual(
    expect.arrayContaining([
      {
        table: 'routing_evidence',
        id: scoredRunId,
        space: spaceId,
        op: 'upsert',
        row: routingAfterLens,
      },
      {
        table: 'run_score',
        id: scoredRunId,
        space: spaceId,
        op: 'upsert',
        row: scoreAfterLens,
      },
    ]),
  )
  expect(routingAfterLens.lenses).toContain('feed-review-lens')
})
