import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  createRecordContractFixture,
  RECORD_CONTRACT_SPACE_B,
  type RecordContractFixture,
} from '../../test/fixtures/record-contract.ts'

export const contractRoutes = ['GET /v1/task-flow'] as const

const PROJECT = '01990000-0000-7000-8000-000000024570'
const TASK = '01990000-0000-7000-8000-000000024571'
const FLOW = '01990000-0000-7000-8000-000000024572'
const MACHINE = '01990000-0000-7000-8000-000000024573'

let fixture: RecordContractFixture

beforeAll(async () => {
  fixture = await createRecordContractFixture()
  await fixture.database.exec(`
    RESET ROLE;
    INSERT INTO machine (id,user_id,name,registered_at,last_seen)
    VALUES ('${MACHINE}','01990000-0000-7000-8000-000000024562','Contract machine',now(),now());
    INSERT INTO project (id,space_id,name,key_prefixes,created_at)
    VALUES ('${PROJECT}','${RECORD_CONTRACT_SPACE_B}','contract-project',ARRAY['DEV'],now());
    INSERT INTO hub_task
      (id,space_id,project_name,project_id,key,project,source,first_seen,last_seen,created_at,updated_at)
    VALUES ('${TASK}','${RECORD_CONTRACT_SPACE_B}','contract-project','${PROJECT}','DEV-2455',
      'contract-project','mcp',now(),now(),now(),now());
    INSERT INTO task_flow
      (id,space_id,project_id,task_id,state,opening_machine_id,updated_machine_id,revision,created_at,updated_at)
    VALUES ('${FLOW}','${RECORD_CONTRACT_SPACE_B}','${PROJECT}','${TASK}','open','${MACHINE}',
      '${MACHINE}',1,now(),now());
    SET ROLE record_actor;
  `)
})

afterAll(async () => {
  if (!fixture) return
  expect([...fixture.requestedRoutes]).toEqual(expect.arrayContaining([...contractRoutes]))
  await fixture.close()
})

test('a task flow in another member space is found by task id while space A is active', async () => {
  await expect(fixture.client.readTaskFlow?.({ taskId: TASK })).resolves.toMatchObject({
    flow: { id: FLOW, taskId: TASK },
    space_id: RECORD_CONTRACT_SPACE_B,
  })
})
