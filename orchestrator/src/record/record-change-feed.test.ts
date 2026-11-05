import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { type RecordChangeEntry, readRecordChanges } from '../../../shared/record/record-changes.ts'
import { createHostedRecordFixture, pgliteSql } from '../../test/fixtures/hosted-record.ts'
import { familyKeys, materializeRecordChangePage } from './record-change-feed.ts'
import { recordDocRow } from './record-doc-mapping.ts'
import { recordDocRows } from './record-doc-read.ts'
import { mapRecordPortRow, recordPortRows } from './record-port-catalogue.ts'
import { mapRecordProjectRow, recordProjectRows } from './record-projects.ts'

const spaceId = '01990000-0000-7000-8000-000000002100'
const userId = '01990000-0000-7000-8000-000000002101'
const projectId = '01990000-0000-7000-8000-000000002102'
const docId = '01990000-0000-7000-8000-000000002103'
const relatedSubjectId = '01990000-0000-7000-8000-000000002104'
const deletedSubjectId = '01990000-0000-7000-8000-000000002105'
const relationId = '01990000-0000-7000-8000-000000002106'
const doctrineId = '01990000-0000-7000-8000-000000002107'
const excludedRunId = '01990000-0000-7000-8000-000000002108'

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

test('materialized changes reuse pull rows and preserve child mappings and tombstones', async () => {
  await database.exec(`
    INSERT INTO project (id,space_id,name,key_prefixes,created_at)
    VALUES ('${projectId}','${spaceId}','feed-project',ARRAY['FEED'],now());
    INSERT INTO doc (
      id,space_id,scope,subject,slug,title,body,delivery,audiences,project_id,created_at,updated_at
    ) VALUES (
      '${docId}','${spaceId}','project','feed-project','feed-doc','Feed doc','Body','demand',
      ARRAY['technical'],'${projectId}',now(),now()
    );
    INSERT INTO subject (id,space_id,project_id,name,definition,position,created_at,updated_at)
    VALUES
      ('${relatedSubjectId}','${spaceId}','${projectId}','Related','Related definition',0,now(),now()),
      ('${deletedSubjectId}','${spaceId}','${projectId}','Deleted','Deleted definition',1,now(),now());
    INSERT INTO doc_related_subject (id,space_id,doc_id,subject_id)
    VALUES ('${relationId}','${spaceId}','${docId}','${relatedSubjectId}');
    INSERT INTO port_doctrine (id,space_id,number,title,body,created_at)
    VALUES ('${doctrineId}','${spaceId}',1,'Feed doctrine','Feed body',now());
    DELETE FROM subject WHERE id='${deletedSubjectId}';
    INSERT INTO run_exclusion (run_id,space_id,reason,excluded_at)
    VALUES ('${excludedRunId}','${spaceId}','excluded from evidence',now());
  `)

  const sql = pgliteSql(database)
  const feed = await readRecordChanges(
    sql,
    { userId, spaceId, spaceIds: [spaceId] },
    { xid: 0n, seq: 0n },
    100,
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
  expect(docPull.relatedSubjects).toEqual([{ id: relatedSubjectId, name: 'Related' }])
  expect(
    feed.changes.filter((entry) => entry.id === excludedRunId).map((entry) => entry.table),
  ).toEqual(['routing_evidence', 'run_score'])
})
