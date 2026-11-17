import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { createHostedRecordFixture, pgliteSql } from '../../test/fixtures/hosted-record.ts'
import { readRecordTaskFlowTextTransaction } from './record-task-flow.ts'

const SPACE = '01990000-0000-7000-8000-000000002416'
const USER = '01990000-0000-7000-8000-000000002417'
const PROJECT = '01990000-0000-7000-8000-000000002418'
const MACHINE = '01990000-0000-7000-8000-000000002419'
const WORKFLOW = '01990000-0000-7000-8000-000000002420'
const WORKFLOW_VERSION = '01990000-0000-7000-8000-000000002421'
const CATALOGUE = '01990000-0000-7000-8000-000000002422'
const CATALOGUE_VERSION = '01990000-0000-7000-8000-000000002423'
const FLOW = '01990000-0000-7000-8000-000000002424'
const STAGE = '01990000-0000-7000-8000-000000002425'
const TEXT = '01990000-0000-7000-8000-000000002426'
const COPY = '01990000-0000-7000-8000-000000002427'

let postgres: PGlite

beforeEach(async () => {
  postgres = await createHostedRecordFixture({ spaceId: SPACE, userId: USER })
  await postgres.exec(`
    RESET ROLE;
    INSERT INTO project (id,space_id,name,key_prefixes,created_at)
    VALUES ('${PROJECT}','${SPACE}','text-copy',ARRAY['DEV'],now());
    INSERT INTO machine (id,user_id,name,registered_at,last_seen)
    VALUES ('${MACHINE}','${USER}','text-copy',now(),now());
    INSERT INTO workflow (id,space_id,slug,created_at,updated_at)
    VALUES ('${WORKFLOW}','${SPACE}','proof',now(),now());
    INSERT INTO workflow_version
      (id,space_id,workflow_id,n,status,definition,author,reason,created_at,updated_at)
    VALUES ('${WORKFLOW_VERSION}','${SPACE}','${WORKFLOW}',1,'production','{}','test','proof',now(),now());
    INSERT INTO step_catalogue (id,space_id,slug,created_at,updated_at)
    VALUES ('${CATALOGUE}','${SPACE}','proof',now(),now());
    INSERT INTO step_catalogue_version
      (id,space_id,catalogue_id,n,status,definition,author,reason,created_at,updated_at)
    VALUES ('${CATALOGUE_VERSION}','${SPACE}','${CATALOGUE}',1,'production','{}','test','proof',now(),now());
    INSERT INTO task_flow
      (id,space_id,project_id,state,opening_machine_id,updated_machine_id,revision,created_at,updated_at)
    VALUES ('${FLOW}','${SPACE}','${PROJECT}','open','${MACHINE}','${MACHINE}',1,now(),now());
    INSERT INTO task_flow_stage
      (id,space_id,flow_record_id,project_id,number,workflow,mode,workflow_key,session_id,
       workflow_version_id,catalogue_version_id,arguments,active_ordinal,active_slug,state,
       closed_step_notes,total_steps,opened_machine_id,last_advanced_machine_id,revision,created_at,updated_at)
    VALUES ('${STAGE}','${SPACE}','${FLOW}','${PROJECT}',1,'proof','default','DEV-2416','session',
      '${WORKFLOW_VERSION}','${CATALOGUE_VERSION}','{}',0,'implementation','running',
      '[]',1,'${MACHINE}','${MACHINE}',1,now(),now());
    INSERT INTO workflow_step_text
      (id,space_id,stage_record_id,step_ordinal,step_slug,body,created_at)
    VALUES ('${TEXT}','${SPACE}','${STAGE}',0,'implementation','durable body',now());
    INSERT INTO workflow_text_copy
      (id,space_id,workflow_text_record_id,stage_record_id,task_document_reference,copied_at)
    VALUES ('${COPY}','${SPACE}','${TEXT}','${STAGE}','task:DEV-2416/guard',now());
    SET ROLE record_actor;
  `)
})

afterEach(async () => {
  await postgres.close()
})

test('hosted text read returns a copy after its live text is removed', async () => {
  const sql = pgliteSql(postgres)
  expect(await readRecordTaskFlowTextTransaction(sql, TEXT)).toMatchObject({
    text: { body: 'durable body' },
    copy: { taskDocumentReference: 'task:DEV-2416/guard' },
  })

  await postgres.exec(`DELETE FROM workflow_step_text WHERE id='${TEXT}'`)

  const orphanCopies = (
    await postgres.query<{ workflow_text_record_id: string }>(`
      SELECT c.workflow_text_record_id FROM workflow_text_copy c
      LEFT JOIN workflow_step_text t
        ON t.id=c.workflow_text_record_id AND t.space_id=c.space_id
      WHERE t.id IS NULL
    `)
  ).rows
  expect(orphanCopies).toHaveLength(1)
  for (const orphan of orphanCopies)
    expect(
      await readRecordTaskFlowTextTransaction(sql, orphan.workflow_text_record_id),
    ).toMatchObject({
      text: null,
      stage: { id: STAGE, number: 1 },
      copy: { workflowTextRecordId: TEXT, taskDocumentReference: 'task:DEV-2416/guard' },
    })
})
