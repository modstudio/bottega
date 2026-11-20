import { expect, test } from 'bun:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  createRecordContractFixture,
  type RecordContractFixture,
  RECORD_CONTRACT_SPACE_A,
  RECORD_CONTRACT_SPACE_B,
  RECORD_CONTRACT_USER,
} from '../../test/fixtures/record-contract.ts'
import { db } from '../database/db.ts'
import { rememberActiveRecordSpace } from '../project-space.ts'
import { rememberProjectSpace } from '../project-space-cache.ts'
import { rememberHostedRecord } from '../record/install-binding-write.ts'
import { machineId } from '../record/machine-identity.ts'
import type { RecordRequestDestination } from '../record/record-api-client-paths.ts'
import type { RecordIdentity } from '../record/record-auth.ts'
import { awaitCommand } from '../workflow/workflow-commands.ts'
import { awaitWorkflowRuling } from '../workflow/workflow-cursor.ts'
import { workflowRulingContextFixture } from './mcp-context-reports.fixture.ts'

const PROJECT_SPACE = '01990000-0000-7000-8000-000000025100'
const PROJECT = '01990000-0000-7000-8000-000000025101'
const TASK = '01990000-0000-7000-8000-000000025102'
const FLOW = '01990000-0000-7000-8000-000000025103'
const STAGE = '01990000-0000-7000-8000-000000025104'
const WORKFLOW = '01990000-0000-7000-8000-000000025106'
const WORKFLOW_VERSION = '01990000-0000-7000-8000-000000025107'
const CATALOGUE = '01990000-0000-7000-8000-000000025108'
const CATALOGUE_VERSION = '01990000-0000-7000-8000-000000025109'
const STRAY_QUESTION = '01990000-0000-7000-8000-000000025111'

const identity: RecordIdentity = {
  user: { id: RECORD_CONTRACT_USER, email: 'contract@example.test', emailVerified: true },
  personalSpaceId: RECORD_CONTRACT_SPACE_A,
  activeSpaceId: RECORD_CONTRACT_SPACE_B,
  memberships: [
    {
      space_id: RECORD_CONTRACT_SPACE_A,
      name: 'Personal',
      slug: 'personal',
      role: 'owner',
      permission: 'write',
    },
    {
      space_id: RECORD_CONTRACT_SPACE_B,
      name: PLATFORM_NAME,
      slug: 'active-space',
      role: 'member',
      permission: 'write',
    },
    {
      space_id: PROJECT_SPACE,
      name: 'Modstudio',
      slug: 'modstudio',
      role: 'member',
      permission: 'write',
    },
  ],
}

function seedLocalRoute(): void {
  db()
    .query(
      `INSERT INTO project(record_id,name,path,stack,settings)
       VALUES (?,'segnavia','/tmp/segnavia','bun',?)`,
    )
    .run(PROJECT, JSON.stringify({ space: 'modstudio', tracker: { protocol: 'hub' } }))
  db()
    .query('INSERT INTO workflow(record_id,slug,created_at) VALUES (?,?,?)')
    .run(WORKFLOW, 'plan-task', '2026-11-16T00:00:00Z')
  db()
    .query(
      `INSERT INTO workflow_version
       (record_id,workflow_record_id,n,status,definition,author,reason,created_at)
       VALUES (?,?,1,'production',?,'test','proof',?)`,
    )
    .run(
      WORKFLOW_VERSION,
      WORKFLOW,
      JSON.stringify({
        title: 'Plan task',
        description: 'Proof workflow.',
        arguments: [{ name: 'key', required: true, description: 'Task key.' }],
        modes: [{ slug: 'feature', title: 'Feature', default: true, steps: ['design-signoff'] }],
      }),
      '2026-11-16T00:00:00Z',
    )
  db()
    .query('INSERT INTO step_catalogue(record_id,slug,created_at) VALUES (?,?,?)')
    .run(CATALOGUE, 'await-destination', '2026-11-16T00:00:00Z')
  db()
    .query(
      `INSERT INTO step_catalogue_version
       (record_id,catalogue_record_id,n,status,definition,author,reason,created_at)
       VALUES (?,?,1,'production',?,'test','proof',?)`,
    )
    .run(
      CATALOGUE_VERSION,
      CATALOGUE,
      JSON.stringify({
        steps: [
          {
            slug: 'design-signoff',
            title: 'Design signoff',
            body: 'Ask.',
            stage: 'design',
            autonomy: 'ask',
            needs: [],
            floor: [],
            jobs: [],
            actions: [],
          },
        ],
      }),
      '2026-11-16T00:00:00Z',
    )
  rememberHostedRecord(db())
  rememberActiveRecordSpace(db(), RECORD_CONTRACT_SPACE_B)
  rememberProjectSpace(db(), 'segnavia', PROJECT_SPACE)
}

async function seedHostedAwait(
  fixture: RecordContractFixture,
  taskFlowSpace: string,
): Promise<void> {
  const localMachine = machineId()
  await fixture.database.exec(`
    RESET ROLE;
    INSERT INTO space(id,name,slug,created_at)
    VALUES ('${PROJECT_SPACE}','Modstudio','modstudio',now());
    INSERT INTO membership(id,space_id,user_id,role,permission,created_at)
    VALUES ('01990000-0000-7000-8000-000000025110','${PROJECT_SPACE}',
      '${RECORD_CONTRACT_USER}','member','write',now());
    INSERT INTO project(id,space_id,name,key_prefixes,created_at)
    VALUES ('${PROJECT}','${PROJECT_SPACE}','segnavia',ARRAY['SEGNA'],now());
    INSERT INTO machine(id,user_id,name,registered_at,last_seen)
    VALUES ('${localMachine}','${RECORD_CONTRACT_USER}','await-proof',now(),now());
    INSERT INTO workflow(id,space_id,slug,created_at,updated_at)
    VALUES ('${WORKFLOW}','${PROJECT_SPACE}','plan-task',now(),now());
    INSERT INTO workflow_version
      (id,space_id,workflow_id,n,status,definition,author,reason,created_at,updated_at)
    VALUES ('${WORKFLOW_VERSION}','${PROJECT_SPACE}','${WORKFLOW}',1,
      'production','{}','test','proof',now(),now());
    INSERT INTO step_catalogue(id,space_id,slug,created_at,updated_at)
    VALUES ('${CATALOGUE}','${PROJECT_SPACE}','shared',now(),now());
    INSERT INTO step_catalogue_version
      (id,space_id,catalogue_id,n,status,definition,author,reason,created_at,updated_at)
    VALUES ('${CATALOGUE_VERSION}','${PROJECT_SPACE}','${CATALOGUE}',1,
      'production','{}','test','proof',now(),now());
    INSERT INTO hub_task
      (id,space_id,project_name,project_id,key,project,source,first_seen,last_seen,created_at,updated_at)
    VALUES ('${TASK}','${PROJECT_SPACE}','segnavia','${PROJECT}','SEGNA-585',
      'segnavia','mcp',now(),now(),now(),now());
    INSERT INTO task_flow
      (id,space_id,project_id,task_id,state,open_stage_record_id,
       opening_machine_id,updated_machine_id,revision,created_at,updated_at)
    VALUES ('${FLOW}','${taskFlowSpace}','${PROJECT}','${TASK}','open','${STAGE}',
      '${localMachine}','${localMachine}',1,'2026-11-16T00:00:00Z','2026-11-16T00:00:00Z');
    INSERT INTO task_flow_stage
      (id,space_id,flow_record_id,project_id,number,workflow,mode,workflow_key,session_id,
       workflow_version_id,catalogue_version_id,arguments,active_ordinal,active_slug,state,
       closed_step_notes,enforcement,total_steps,opened_machine_id,last_advanced_machine_id,
       revision,created_at,updated_at)
    VALUES ('${STAGE}','${taskFlowSpace}','${FLOW}','${PROJECT}',566,'plan-task','feature',
      'SEGNA-585','old-session','${WORKFLOW_VERSION}','${CATALOGUE_VERSION}',
      '{"key":"SEGNA-585"}',0,'design-signoff','running','[]','note-only',1,
      '${localMachine}','${localMachine}',1,'2026-11-16T00:00:00Z','2026-11-16T00:00:00Z');
    INSERT INTO question
      (id,space_id,workflow_cursor_record_id,project_id,machine_id,number,revision,
       asked_at,question,awaiting_operator_at,withheld_fields,created_at,updated_at)
    VALUES ('${STRAY_QUESTION}','${RECORD_CONTRACT_SPACE_A}','${STAGE}','${PROJECT}',
      '${localMachine}',1,1,'2026-11-16T00:00:00Z','Old question',
      '2026-11-16T00:00:00Z','[]','2026-11-16T00:00:00Z','2026-11-16T00:00:00Z');
    SET ROLE record_actor;
  `)
}

test('CLI and MCP workflow await writes name the cursor project space', async () => {
  seedLocalRoute()
  const fixture = await createRecordContractFixture({ identity })
  try {
    await seedHostedAwait(fixture, PROJECT_SPACE)
    const hubTaskReader = async () => [{ key: 'SEGNA-585', record_id: TASK, project: 'segnavia' }]
    await awaitCommand(
      [
        'workflow',
        'await',
        'plan-task',
        '--mode',
        'feature',
        '--cursor',
        '566',
        '--project',
        'segnavia',
        '--arg',
        'key=SEGNA-585',
        '--question',
        'Proceed?',
      ],
      () => {},
      { hubTaskReader },
    )
    const { server } = workflowRulingContextFixture({ hubTaskReader })
    const client = new Client({ name: 'await-proof', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const result = await client.callTool({
        name: 'await_workflow_ruling',
        arguments: {
          slug: 'plan-task',
          project: 'segnavia',
          mode: 'feature',
          cursor: 566,
          args: { key: 'SEGNA-585' },
          question: 'Proceed?',
        },
      })
      expect(result.isError).not.toBe(true)
    } finally {
      await client.close()
      await server.close()
    }
    const writes = fixture.requests.filter(({ path }) => !path.startsWith('GET '))
    expect(writes).toEqual([
      { path: 'POST /v1/questions/ask', destinationSpaceId: PROJECT_SPACE },
      { path: 'POST /v1/questions/close', destinationSpaceId: RECORD_CONTRACT_SPACE_A },
      { path: 'POST /v1/task-flow/await-ruling', destinationSpaceId: PROJECT_SPACE },
      { path: 'POST /v1/questions/link', destinationSpaceId: PROJECT_SPACE },
      { path: 'POST /v1/task-flow/await-ruling', destinationSpaceId: PROJECT_SPACE },
    ])
  } finally {
    await fixture.close()
  }
})

test('workflow await leaves a personal-space stray open when the replacement ask is refused', async () => {
  seedLocalRoute()
  const fixture = await createRecordContractFixture({
    identity: { ...identity, activeSpaceId: RECORD_CONTRACT_SPACE_A },
  })
  try {
    await seedHostedAwait(fixture, RECORD_CONTRACT_SPACE_A)
    const taskFlowClient = {
      ...fixture.client,
      listTaskFlowStages: (
        input: Parameters<NonNullable<typeof fixture.client.listTaskFlowStages>>[0],
        _destination?: RecordRequestDestination,
      ) =>
        fixture.client.listTaskFlowStages!(input, {
          destinationSpaceId: RECORD_CONTRACT_SPACE_A,
        }).then((result) => ({
          ...result,
          items: result.items.map((item) => ({
            ...item,
            stage: {
              ...item.stage,
              projectName: 'segnavia',
              workflowVersionNumber: 1,
              catalogueVersionNumber: 1,
            },
          })),
        })),
    }

    await expect(
      awaitWorkflowRuling(
        'plan-task',
        'segnavia',
        'feature',
        { key: 'SEGNA-585' },
        'Proceed?',
        { session: 'old-session', taskFlowClient },
        db(),
        () => {},
        566,
      ),
    ).rejects.toThrow(
      `workflow cursor ${STAGE} is absent from the question's destination space; ` +
        `ask through the cursor's project with \`${PLATFORM_SLUG} workflow await\` so the question is written to the space that holds the cursor`,
    )

    expect(fixture.requests.filter(({ path }) => !path.startsWith('GET '))).toEqual([
      { path: 'POST /v1/questions/ask', destinationSpaceId: PROJECT_SPACE },
    ])
    await fixture.database.exec('RESET ROLE;')
    const stray = await fixture.database.query<{ closed: boolean }>(
      `SELECT closed_at IS NOT NULL closed FROM question WHERE id='${STRAY_QUESTION}'`,
    )
    await fixture.database.exec('SET ROLE record_actor;')
    expect(stray.rows).toEqual([{ closed: false }])
  } finally {
    await fixture.close()
  }
})
