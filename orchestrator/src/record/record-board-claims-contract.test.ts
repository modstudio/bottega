import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  createRecordContractFixture,
  RECORD_CONTRACT_SPACE_A,
  RECORD_CONTRACT_USER,
  type RecordContractFixture,
} from '../../test/fixtures/record-contract.ts'

const contractRoutes = ['PUT /v1/board/claims'] as const

const PROJECT = '01990000-0000-7000-8000-000000024580'
const MACHINE = '01990000-0000-7000-8000-000000024581'
const FLOW = '01990000-0000-7000-8000-000000024582'
const STAGE = '01990000-0000-7000-8000-000000024583'
const WORKFLOW = '01990000-0000-7000-8000-000000024584'
const WORKFLOW_VERSION = '01990000-0000-7000-8000-000000024585'
const CATALOGUE = '01990000-0000-7000-8000-000000024586'
const CATALOGUE_VERSION = '01990000-0000-7000-8000-000000024587'

let fixture: RecordContractFixture

beforeAll(async () => {
  fixture = await createRecordContractFixture()
  await fixture.database.exec(`
    RESET ROLE;
    INSERT INTO machine (id,user_id,name,registered_at,last_seen)
    VALUES ('${MACHINE}','${RECORD_CONTRACT_USER}','Contract machine',now(),now());
    INSERT INTO project (id,space_id,name,key_prefixes,created_at)
    VALUES ('${PROJECT}','${RECORD_CONTRACT_SPACE_A}','contract-project',ARRAY['DEV'],now());
    INSERT INTO workflow (id,space_id,slug,created_at,updated_at)
    VALUES ('${WORKFLOW}','${RECORD_CONTRACT_SPACE_A}','contract',now(),now());
    INSERT INTO workflow_version
      (id,space_id,workflow_id,n,status,definition,author,reason,created_at,updated_at)
    VALUES ('${WORKFLOW_VERSION}','${RECORD_CONTRACT_SPACE_A}','${WORKFLOW}',1,'production','{}',
      'test','contract',now(),now());
    INSERT INTO step_catalogue (id,space_id,slug,created_at,updated_at)
    VALUES ('${CATALOGUE}','${RECORD_CONTRACT_SPACE_A}','contract',now(),now());
    INSERT INTO step_catalogue_version
      (id,space_id,catalogue_id,n,status,definition,author,reason,created_at,updated_at)
    VALUES ('${CATALOGUE_VERSION}','${RECORD_CONTRACT_SPACE_A}','${CATALOGUE}',1,'production','{}',
      'test','contract',now(),now());
    INSERT INTO task_flow
      (id,space_id,project_id,state,opening_machine_id,updated_machine_id,revision,created_at,updated_at)
    VALUES ('${FLOW}','${RECORD_CONTRACT_SPACE_A}','${PROJECT}','open','${MACHINE}','${MACHINE}',1,now(),now());
    INSERT INTO task_flow_stage
      (id,space_id,flow_record_id,project_id,number,workflow,mode,workflow_key,session_id,
       workflow_version_id,catalogue_version_id,arguments,active_ordinal,active_slug,state,
       closed_step_notes,enforcement,total_steps,opened_machine_id,last_advanced_machine_id,
       revision,created_at,updated_at)
    VALUES ('${STAGE}','${RECORD_CONTRACT_SPACE_A}','${FLOW}','${PROJECT}',1,'contract','default',
      'DEV-2424','owner-session','${WORKFLOW_VERSION}','${CATALOGUE_VERSION}','{}',0,
      'implementation','running','[]','signed',1,'${MACHINE}','${MACHINE}',1,now(),now());
    UPDATE task_flow SET open_stage_record_id='${STAGE}' WHERE id='${FLOW}';
    SET ROLE record_actor;
  `)
})

afterAll(async () => {
  if (!fixture) return
  expect([...fixture.requestedRoutes]).toEqual(expect.arrayContaining([...contractRoutes]))
  await fixture.close()
})

const claim = (id: string, holderSession: string) => ({
  id,
  project: 'contract-project',
  projectId: PROJECT,
  subject: 'task:DEV-2424',
  holderSession,
})

test('a task claim is admitted only for the session that owns its open stage', async () => {
  await expect(
    fixture.client.takeBoardClaim(claim('01990000-0000-7000-8000-000000024588', 'other-session'), {
      destinationSpaceId: RECORD_CONTRACT_SPACE_A,
    }),
  ).rejects.toThrow('task claims follow task cursors')
  await expect(
    fixture.client.takeBoardClaim(claim('01990000-0000-7000-8000-000000024589', 'owner-session'), {
      destinationSpaceId: RECORD_CONTRACT_SPACE_A,
    }),
  ).resolves.toMatchObject({
    action: 'taken',
    holderSession: 'owner-session',
    subject: { kind: 'task', value: 'DEV-2424' },
  })
})
