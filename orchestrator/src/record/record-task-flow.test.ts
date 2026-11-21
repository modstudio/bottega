import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { bindTenant } from '../../../shared/record/tenant.ts'
import { createHostedRecordFixture, pgliteSql } from '../../test/fixtures/hosted-record.ts'
import { requestTenant } from './record-api-tenant.ts'
import type { RecordIdentity } from './record-auth.ts'
import { recordRequestReadKind } from './record-keyed-read.ts'
import {
  listRecordTaskFlowStagesTransaction,
  readRecordTaskFlowPresenceTransaction,
  readRecordTaskFlowTextTransaction,
  readRecordTaskFlowTransaction,
} from './record-task-flow.ts'

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
const OBLIGATION = '01990000-0000-7000-8000-000000002428'
const QUESTION = '01990000-0000-7000-8000-000000002429'
const QUESTION_AUDIT = '01990000-0000-7000-8000-000000002430'
const INCOMPLETE_STAGE = '01990000-0000-7000-8000-000000002431'

const SECOND = {
  space: '01990000-0000-7000-8000-000000002432',
  membership: '01990000-0000-7000-8000-000000002433',
  project: '01990000-0000-7000-8000-000000002434',
  workflow: '01990000-0000-7000-8000-000000002435',
  workflowVersion: '01990000-0000-7000-8000-000000002436',
  catalogue: '01990000-0000-7000-8000-000000002437',
  catalogueVersion: '01990000-0000-7000-8000-000000002438',
  task: '01990000-0000-7000-8000-000000002460',
  flow: '01990000-0000-7000-8000-000000002439',
  stage: '01990000-0000-7000-8000-000000002440',
  obligation: '01990000-0000-7000-8000-000000002441',
  text: '01990000-0000-7000-8000-000000002442',
  copy: '01990000-0000-7000-8000-000000002443',
  question: '01990000-0000-7000-8000-000000002444',
  questionAudit: '01990000-0000-7000-8000-000000002445',
}
const OUTSIDER = {
  space: '01990000-0000-7000-8000-000000002446',
  membership: '01990000-0000-7000-8000-000000002447',
  project: '01990000-0000-7000-8000-000000002448',
  workflow: '01990000-0000-7000-8000-000000002449',
  workflowVersion: '01990000-0000-7000-8000-000000002450',
  catalogue: '01990000-0000-7000-8000-000000002451',
  catalogueVersion: '01990000-0000-7000-8000-000000002452',
  task: '01990000-0000-7000-8000-000000002461',
  flow: '01990000-0000-7000-8000-000000002453',
  stage: '01990000-0000-7000-8000-000000002454',
  obligation: '01990000-0000-7000-8000-000000002455',
  text: '01990000-0000-7000-8000-000000002456',
  copy: '01990000-0000-7000-8000-000000002457',
  question: '01990000-0000-7000-8000-000000002458',
  questionAudit: '01990000-0000-7000-8000-000000002459',
}

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

test('stage-list summary omits only closed-step notes and autonomy', async () => {
  await postgres.exec(`
    RESET ROLE;
    UPDATE task_flow_stage
    SET closed_step_notes='[{"slug":"implementation","note":"complete"}]', autonomy='delegated'
    WHERE id='${STAGE}';
    SET ROLE record_actor;
  `)
  const base = {
    userId: USER,
    spaceId: SPACE,
    projectId: PROJECT,
    order: 'project' as const,
    limit: 200,
  }
  const sql = pgliteSql(postgres)
  const full = await listRecordTaskFlowStagesTransaction(sql, base)
  expect(full).toEqual({
    items: [
      {
        stage: {
          id: STAGE,
          flowRecordId: FLOW,
          projectId: PROJECT,
          projectName: 'text-copy',
          number: 1,
          workflow: 'proof',
          mode: 'default',
          workflowKey: 'DEV-2416',
          instanceId: null,
          sessionId: 'session',
          workflowVersionId: WORKFLOW_VERSION,
          workflowVersionNumber: 1,
          catalogueVersionId: CATALOGUE_VERSION,
          catalogueVersionNumber: 1,
          arguments: {},
          activeOrdinal: 0,
          activeSlug: 'implementation',
          state: 'running',
          closedStepNotes: [{ slug: 'implementation', note: 'complete' }],
          question: null,
          autonomy: 'delegated',
          enforcement: null,
          totalSteps: 1,
          openedMachineId: MACHINE,
          takenOverFromMachineId: null,
          lastAdvancedMachineId: MACHINE,
          handedOffFromRecordId: null,
          revision: 1,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
        flow: {
          id: FLOW,
          projectId: PROJECT,
          taskId: null,
          parentFlowRecordId: null,
          taskKey: null,
          state: 'open',
          openStageRecordId: null,
          openStageCount: 1,
          openingMachineId: MACHINE,
          updatedMachineId: MACHINE,
          revision: 1,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      },
    ],
    truncated: false,
    nextCursor: null,
  })

  const summary = await listRecordTaskFlowStagesTransaction(sql, { ...base, view: 'summary' })
  const fullStage = full.items[0]!.stage as Record<string, unknown>
  const summaryStage = summary.items[0]!.stage as Record<string, unknown>
  expect(
    Object.keys(fullStage)
      .filter((key) => !(key in summaryStage))
      .sort(),
  ).toEqual(['autonomy', 'closedStepNotes'])
  expect(summaryStage).toEqual(
    Object.fromEntries(
      Object.entries(fullStage).filter(([key]) => key !== 'closedStepNotes' && key !== 'autonomy'),
    ),
  )
  expect(summary.items[0]!.flow).toEqual(full.items[0]!.flow)
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

async function seedPresenceSpace(row: typeof SECOND, member: boolean) {
  await postgres.exec(`
    RESET ROLE;
    INSERT INTO space (id,name,slug,created_at)
    VALUES ('${row.space}','Presence ${row.space}','presence-${row.space}',now());
    ${
      member
        ? `INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
           VALUES ('${row.membership}','${row.space}','${USER}','member','write',now());`
        : ''
    }
    INSERT INTO project (id,space_id,name,key_prefixes,created_at)
    VALUES ('${row.project}','${row.space}','presence',ARRAY['PRE'],now());
    INSERT INTO hub_task
      (id,space_id,project_name,project_id,key,project,source,first_seen,last_seen,created_at,updated_at)
    VALUES ('${row.task}','${row.space}','presence','${row.project}','PRE-1','presence','mcp',
      now(),now(),now(),now());
    INSERT INTO workflow (id,space_id,slug,created_at,updated_at)
    VALUES ('${row.workflow}','${row.space}','presence',now(),now());
    INSERT INTO workflow_version
      (id,space_id,workflow_id,n,status,definition,author,reason,created_at,updated_at)
    VALUES ('${row.workflowVersion}','${row.space}','${row.workflow}',1,'production','{}',
      'test','proof',now(),now());
    INSERT INTO step_catalogue (id,space_id,slug,created_at,updated_at)
    VALUES ('${row.catalogue}','${row.space}','presence',now(),now());
    INSERT INTO step_catalogue_version
      (id,space_id,catalogue_id,n,status,definition,author,reason,created_at,updated_at)
    VALUES ('${row.catalogueVersion}','${row.space}','${row.catalogue}',1,'production','{}',
      'test','proof',now(),now());
    INSERT INTO task_flow
      (id,space_id,project_id,task_id,state,opening_machine_id,updated_machine_id,revision,created_at,updated_at)
    VALUES ('${row.flow}','${row.space}','${row.project}','${row.task}','open','${MACHINE}','${MACHINE}',1,now(),now());
    INSERT INTO task_flow_stage
      (id,space_id,flow_record_id,project_id,number,workflow,mode,workflow_key,session_id,
       workflow_version_id,catalogue_version_id,arguments,active_ordinal,active_slug,state,
       closed_step_notes,enforcement,total_steps,opened_machine_id,last_advanced_machine_id,
       revision,created_at,updated_at)
    VALUES ('${row.stage}','${row.space}','${row.flow}','${row.project}',1,'presence','default',
      'PRE-1','session','${row.workflowVersion}','${row.catalogueVersion}','{}',0,
      'implementation','running','[]','signed',1,'${MACHINE}','${MACHINE}',1,now(),now());
    UPDATE task_flow SET open_stage_record_id='${row.stage}' WHERE id='${row.flow}';
    INSERT INTO workflow_obligation
      (id,space_id,stage_record_id,step_ordinal,step_slug,floor,reason,created_at)
    VALUES ('${row.obligation}','${row.space}','${row.stage}',0,'implementation','artifact',
      'proof',now());
    INSERT INTO workflow_step_text
      (id,space_id,stage_record_id,step_ordinal,step_slug,body,created_at)
    VALUES ('${row.text}','${row.space}','${row.stage}',0,'implementation','body',now());
    INSERT INTO workflow_text_copy
      (id,space_id,workflow_text_record_id,stage_record_id,task_document_reference,copied_at)
    VALUES ('${row.copy}','${row.space}','${row.text}','${row.stage}','task:PRE-1/proof',now());
    INSERT INTO question
      (id,number,space_id,workflow_cursor_record_id,machine_id,revision,asked_at,question,
       withheld_fields,created_at,updated_at)
    VALUES ('${row.question}',1,'${row.space}','${row.stage}','${MACHINE}',1,now(),'Proceed?',
      '[]',now(),now());
    INSERT INTO question_mutation_audit (id,question_id,space_id,action,at)
    VALUES ('${row.questionAudit}','${row.question}','${row.space}','ask',now());
    SET ROLE record_actor;
  `)
}

test('task-flow route tenant finds a task UUID in a non-active member space', async () => {
  await seedPresenceSpace(SECOND, true)
  const identity: RecordIdentity = {
    user: { id: USER, email: 'member@example.test' },
    activeSpaceId: SPACE,
    personalSpaceId: SECOND.space,
    memberships: [SPACE, SECOND.space].map((spaceId) => ({
      space_id: spaceId,
      name: 'Member space',
      slug: spaceId,
      role: 'member',
      permission: 'write',
    })),
  }
  const readKind = recordRequestReadKind('/v1/task-flow', (name) =>
    name === 'taskId' ? SECOND.task : undefined,
  )
  const tenant = requestTenant(
    identity,
    undefined,
    'read',
    'postgres://fixture',
    '/v1/task-flow',
    readKind,
  )
  if (!tenant || 'refused' in tenant) throw new Error('task-flow read tenant was refused')

  const result = await pgliteSql(postgres).begin((tx) =>
    readRecordTaskFlowTransaction(tx, { ...tenant, taskId: SECOND.task }),
  )
  expect(result).toMatchObject({
    flow: { id: SECOND.flow, openStageRecordId: SECOND.stage },
    stage: { id: SECOND.stage },
  })

  const taskKeyTenant = requestTenant(
    identity,
    undefined,
    'read',
    'postgres://fixture',
    '/v1/task-flow',
    recordRequestReadKind('/v1/task-flow', (name) => (name === 'taskKey' ? 'PRE-1' : undefined)),
  )
  if (!taskKeyTenant || 'refused' in taskKeyTenant)
    throw new Error('task-key read tenant was refused')
  await expect(
    pgliteSql(postgres).begin((tx) =>
      readRecordTaskFlowTransaction(tx, { ...taskKeyTenant, taskKey: 'PRE-1' }),
    ),
  ).rejects.toThrow('hosted task flow was not found')
})

test('presence returns every released table across member spaces and excludes other spaces', async () => {
  await postgres.exec(`
    RESET ROLE;
    UPDATE task_flow_stage SET enforcement='signed' WHERE id='${STAGE}';
    INSERT INTO task_flow_stage
      (id,space_id,flow_record_id,project_id,number,workflow,mode,workflow_key,session_id,
       workflow_version_id,catalogue_version_id,arguments,active_ordinal,active_slug,state,
       closed_step_notes,total_steps,opened_machine_id,last_advanced_machine_id,revision,created_at,updated_at)
    VALUES ('${INCOMPLETE_STAGE}','${SPACE}','${FLOW}','${PROJECT}',2,'proof','default','DEV-2417',
      'session','${WORKFLOW_VERSION}','${CATALOGUE_VERSION}','{}',0,'implementation','done',
      '[]',1,'${MACHINE}','${MACHINE}',1,now(),now());
    INSERT INTO workflow_obligation
      (id,space_id,stage_record_id,step_ordinal,step_slug,floor,reason,created_at)
    VALUES ('${OBLIGATION}','${SPACE}','${STAGE}',0,'implementation','artifact','proof',now());
    INSERT INTO question
      (id,number,space_id,workflow_cursor_record_id,machine_id,revision,asked_at,question,
       withheld_fields,created_at,updated_at)
    VALUES ('${QUESTION}',1,'${SPACE}','${STAGE}','${MACHINE}',1,now(),'Proceed?','[]',now(),now());
    INSERT INTO question_mutation_audit (id,question_id,space_id,action,at)
    VALUES ('${QUESTION_AUDIT}','${QUESTION}','${SPACE}','ask',now());
    SET ROLE record_actor;
  `)
  await seedPresenceSpace(SECOND, true)
  await seedPresenceSpace(OUTSIDER, false)

  const result = await pgliteSql(postgres).begin(async (tx) => {
    await bindTenant(tx, { userId: USER, spaceId: SPACE, spaceIds: [SPACE, SECOND.space] })
    return readRecordTaskFlowPresenceTransaction(tx, {
      flowIds: [FLOW, SECOND.flow, OUTSIDER.flow],
      stageIds: [STAGE, INCOMPLETE_STAGE, SECOND.stage, OUTSIDER.stage],
      obligationIds: [OBLIGATION, SECOND.obligation, OUTSIDER.obligation],
      textIds: [TEXT, SECOND.text, OUTSIDER.text],
      textCopyIds: [COPY, SECOND.copy, OUTSIDER.copy],
      questionIds: [QUESTION, SECOND.question, OUTSIDER.question],
      questionAuditIds: [QUESTION_AUDIT, SECOND.questionAudit, OUTSIDER.questionAudit],
    })
  })

  expect(result).toEqual({
    flowIds: [FLOW, SECOND.flow],
    stageIds: [STAGE, SECOND.stage],
    obligationIds: [OBLIGATION, SECOND.obligation],
    textIds: [TEXT, SECOND.text],
    textCopyIds: [COPY, SECOND.copy],
    questionIds: [QUESTION, SECOND.question],
    questionAuditIds: [QUESTION_AUDIT, SECOND.questionAudit],
    questionAuditIdentities: [
      { questionId: QUESTION, action: 'ask', at: expect.any(String) },
      { questionId: SECOND.question, action: 'ask', at: expect.any(String) },
    ],
  })
})
