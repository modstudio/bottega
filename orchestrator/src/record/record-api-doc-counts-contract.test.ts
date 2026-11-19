import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  createRecordContractFixture,
  RECORD_CONTRACT_SPACE_A,
  type RecordContractFixture,
} from '../../test/fixtures/record-contract.ts'

const contractRoutes = ['GET /v1/docs/counts'] as const

const ALPHA = '01990000-0000-7000-8000-000000024590'
const BETA = '01990000-0000-7000-8000-000000024591'

let fixture: RecordContractFixture

beforeAll(async () => {
  fixture = await createRecordContractFixture()
  await fixture.database.exec(`
    RESET ROLE;
    INSERT INTO project (id,space_id,name,key_prefixes,created_at)
    VALUES
      ('${ALPHA}','${RECORD_CONTRACT_SPACE_A}','alpha',ARRAY['ALPHA'],now()),
      ('${BETA}','${RECORD_CONTRACT_SPACE_A}','beta',ARRAY['BETA'],now());
    INSERT INTO subject (id,space_id,project_id,name,definition,position,created_at,updated_at)
    VALUES
      ('01990000-0000-7000-8000-000000024592','${RECORD_CONTRACT_SPACE_A}','${ALPHA}',
        'alpha one','Alpha one.',0,now(),now()),
      ('01990000-0000-7000-8000-000000024593','${RECORD_CONTRACT_SPACE_A}','${ALPHA}',
        'alpha two','Alpha two.',1,now(),now()),
      ('01990000-0000-7000-8000-000000024594','${RECORD_CONTRACT_SPACE_A}','${BETA}',
        'beta one','Beta one.',0,now(),now());
    INSERT INTO doc
      (id,space_id,scope,subject,slug,title,body,delivery,audiences,created_at,updated_at,deleted_at)
    VALUES
      ('01990000-0000-7000-8000-000000024595','${RECORD_CONTRACT_SPACE_A}',
        'global',NULL,'global-live','Global live','Body.','demand',ARRAY['technical'],now(),now(),NULL),
      ('01990000-0000-7000-8000-000000024596','${RECORD_CONTRACT_SPACE_A}',
        'project','alpha','alpha-live','Alpha live','Body.','demand',ARRAY['technical'],now(),now(),NULL),
      ('01990000-0000-7000-8000-000000024597','${RECORD_CONTRACT_SPACE_A}',
        'project','beta','beta-live','Beta live','Body.','demand',ARRAY['technical'],now(),now(),NULL),
      ('01990000-0000-7000-8000-000000024598','${RECORD_CONTRACT_SPACE_A}',
        'project','beta','beta-deleted','Beta deleted','Body.','demand',ARRAY['technical'],now(),now(),now());
    SET ROLE record_actor;
  `)
})

afterAll(async () => {
  if (!fixture) return
  expect([...fixture.requestedRoutes]).toEqual(expect.arrayContaining([...contractRoutes]))
  await fixture.close()
})

test('cache counts group live documents and subjects while legacy counts include deleted docs', async () => {
  await expect(
    fixture.client.cacheCounts({ destinationSpaceId: RECORD_CONTRACT_SPACE_A }),
  ).resolves.toEqual({
    docs: 4,
    revisions: 0,
    scores: 0,
    voids: 0,
    byScope: [
      { scope: 'global', project: null, docs: 1 },
      { scope: 'project', project: 'alpha', docs: 1 },
      { scope: 'project', project: 'beta', docs: 1 },
    ],
    subjectsByProject: [
      { project: 'alpha', subjects: 2 },
      { project: 'beta', subjects: 1 },
    ],
  })
  await expect(
    fixture.client.counts({ destinationSpaceId: RECORD_CONTRACT_SPACE_A }),
  ).resolves.toEqual({ docs: 4, revisions: 0, scores: 0, voids: 0 })
})
