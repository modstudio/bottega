import { afterAll, beforeAll, expect, test } from 'bun:test'
import { resolvedRecordOrigin } from '../../../shared/record-api-url.ts'
import {
  createRecordContractFixture,
  type RecordContractFixture,
  RECORD_CONTRACT_SPACE_A,
  RECORD_CONTRACT_USER,
} from '../../test/fixtures/record-contract.ts'
import { rememberProjectSpace } from '../project-space-cache.ts'
import { taskFlowReadStore } from './task-flow-store.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { database } from './workflow-cursor-test.fixture.ts'
import { handoffWorkflow } from './workflow-handoff.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

export const contractRoutes = [
  'GET /v1/task-flow',
  'POST /v1/task-flow/adopt',
  'POST /v1/task-flow/handoff',
  'PUT /v1/board/claims',
] as const

const TASK = '01990000-0000-7000-8000-000000024590'
const FLOW = '01990000-0000-7000-8000-000000024594'
let fixture: RecordContractFixture

beforeAll(async () => {
  fixture = await createRecordContractFixture()
})

afterAll(async () => {
  if (!fixture) return
  expect([...fixture.requestedRoutes]).toEqual(expect.arrayContaining([...contractRoutes]))
  await fixture.close()
})

function installWorkflow(d: ReturnType<typeof database>, slug: string, keyRequired: boolean) {
  const draft = setWorkflowLocal(
    slug,
    {
      title: slug,
      description: 'record contract handoff',
      arguments: [
        { name: 'key', required: keyRequired, description: 'Task key.' },
        { name: 'branch', required: true, description: 'Branch.' },
        { name: 'worktree', required: true, description: 'Worktree.' },
      ],
      modes: [{ slug: 'default', title: 'Default', default: true, steps: ['score'] }],
    },
    'record contract handoff',
    'test',
    d,
  )
  promoteWorkflowLocal(slug, draft.n, 'record contract handoff', 'test', d)
}

test('a keyless explore handoff adopts before the hosted task claim is taken', async () => {
  const d = database()
  installWorkflow(d, 'contract-explore', false)
  installWorkflow(d, 'contract-target', true)
  d.query("UPDATE project SET settings=? WHERE name='fixture'").run(
    JSON.stringify({
      gate: 'bun run check',
      trunk: 'develop',
      space: 'contract-a',
      docs: { protocol: 'orch-docs' },
      tracker: { protocol: 'hub' },
    }),
  )
  const context = { session: 'contract-handoff-session' }
  const opened = await composeWorkflowWithCursor(
    'contract-explore',
    'fixture',
    'default',
    { branch: 'DEV-2424-work', worktree: '/tmp/DEV-2424' },
    context,
    d,
    {},
    {},
  )
  const row = (await taskFlowReadStore(d).stageByHandle('fixture', opened.cursor!.id))!
  rememberProjectSpace(d, 'fixture', RECORD_CONTRACT_SPACE_A)
  d.query("UPDATE workflow SET space_id=? WHERE slug='contract-target'").run(
    RECORD_CONTRACT_SPACE_A,
  )
  d.query(
    `UPDATE workflow_version SET space_id=?
     WHERE workflow_record_id=(SELECT record_id FROM workflow WHERE slug='contract-target' AND space_id=?)`,
  ).run(RECORD_CONTRACT_SPACE_A, RECORD_CONTRACT_SPACE_A)
  d.query('UPDATE step_catalogue SET space_id=?').run(RECORD_CONTRACT_SPACE_A)
  d.query('UPDATE step_catalogue_version SET space_id=?').run(RECORD_CONTRACT_SPACE_A)
  const project = d
    .query<{ record_id: string }, []>("SELECT record_id FROM project WHERE name='fixture'")
    .get()!.record_id
  d.query(
    `INSERT INTO task_flow
      (record_id,project_record_id,state,opening_machine_id,updated_machine_id,revision,created_at,updated_at)
     VALUES (?,?, 'open',?,?,1,?,?)`,
  ).run(FLOW, project, row.opened_machine_id, row.opened_machine_id, row.created_at, row.updated_at)
  d.query('UPDATE workflow_cursor SET task_flow_record_id=? WHERE record_id=?').run(
    FLOW,
    row.record_id,
  )
  row.task_flow_record_id = FLOW
  const machine = row.opened_machine_id
  const workflow = '01990000-0000-7000-8000-000000024591'
  const catalogue = '01990000-0000-7000-8000-000000024592'
  await fixture.database.exec(`
    RESET ROLE;
    INSERT INTO machine (id,user_id,name,registered_at,last_seen)
    VALUES ('${machine}','${RECORD_CONTRACT_USER}','Contract handoff',now(),now());
    INSERT INTO project (id,space_id,name,key_prefixes,created_at)
    VALUES ('${project}','${RECORD_CONTRACT_SPACE_A}','fixture',ARRAY['DEV'],now());
    INSERT INTO hub_task
      (id,space_id,project_name,project_id,key,project,source,first_seen,last_seen,created_at,updated_at)
    VALUES ('${TASK}','${RECORD_CONTRACT_SPACE_A}','fixture','${project}','DEV-2424','fixture',
      'mcp',now(),now(),now(),now());
    INSERT INTO workflow (id,space_id,slug,created_at,updated_at)
    VALUES ('${workflow}','${RECORD_CONTRACT_SPACE_A}','contract-explore',now(),now());
    INSERT INTO workflow_version
      (id,space_id,workflow_id,n,status,definition,author,reason,created_at,updated_at)
    VALUES ('${row.workflow_version_record_id}','${RECORD_CONTRACT_SPACE_A}','${workflow}',1,
      'production','{}','test','contract',now(),now());
    INSERT INTO step_catalogue (id,space_id,slug,created_at,updated_at)
    VALUES ('${catalogue}','${RECORD_CONTRACT_SPACE_A}','contract',now(),now());
    INSERT INTO step_catalogue_version
      (id,space_id,catalogue_id,n,status,definition,author,reason,created_at,updated_at)
    VALUES ('${row.catalogue_version_record_id}','${RECORD_CONTRACT_SPACE_A}','${catalogue}',1,
      'production','{}','test','contract',now(),now());
    INSERT INTO task_flow
      (id,space_id,project_id,state,opening_machine_id,updated_machine_id,revision,created_at,updated_at)
    VALUES ('${FLOW}','${RECORD_CONTRACT_SPACE_A}','${project}','open','${machine}',
      '${machine}',1,now(),now());
    INSERT INTO task_flow_stage
      (id,space_id,flow_record_id,project_id,number,workflow,mode,session_id,workflow_version_id,
       catalogue_version_id,arguments,active_ordinal,active_slug,state,closed_step_notes,enforcement,
       total_steps,opened_machine_id,last_advanced_machine_id,revision,created_at,updated_at)
    VALUES ('${row.record_id}','${RECORD_CONTRACT_SPACE_A}','${FLOW}','${project}',
      ${row.id},'contract-explore','default','${context.session}','${row.workflow_version_record_id}',
      '${row.catalogue_version_record_id}','${row.args}',0,'score','running','[]','signed',1,
      '${machine}','${machine}',${row.revision},now(),now());
    UPDATE task_flow SET open_stage_record_id='${row.record_id}' WHERE id='${FLOW}';
    SET ROLE record_actor;
  `)
  d.query('INSERT INTO record_install_binding (id,bound_at,record_origin) VALUES (1,?,?)').run(
    '2026-11-18T00:00:00.000Z',
    resolvedRecordOrigin(),
  )
  const result = await handoffWorkflow({
    row,
    workflow: 'contract-target',
    mode: 'default',
    args: { key: 'DEV-2424', branch: 'DEV-2424-work', worktree: '/tmp/DEV-2424' },
    reason: 'task identified',
    context: { ...context, taskRecordId: TASK, taskFlowClient: fixture.client },
    live: {},
    database: d,
    commitCount: () => 0,
    taskClaimPorts: {
      take: ({ project, key, session }) =>
        fixture.client.takeBoardClaim(
          {
            id: '01990000-0000-7000-8000-000000024593',
            project,
            projectId: project,
            subject: `task:${key}`,
            holderSession: session,
          },
          { destinationSpaceId: RECORD_CONTRACT_SPACE_A },
        ) as never,
      release: async () => ({ released: 0 }),
    },
  })
  expect(result.workflow).toBe('contract-target')
})
