import { describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/pglite'
import { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import { syncHostedRecord } from './record-sync-service.ts'
import {
  applyTaskFlowStageValues,
  applyTaskFlowValues,
  taskFlowStageValues,
  taskFlowValues,
} from './record-sync-task-flow.ts'
import {
  readRecordTaskFlowObligation,
  readRecordTaskFlowStage,
  readRecordTaskFlowText,
} from './record-task-flow.ts'

const actorUrl = process.env.BOTTEGA_RECORD_URL
const adminUrl = process.env.BOTTEGA_TEST_POSTGRES_URL
const realPostgres = actorUrl && adminUrl ? describe : describe.skip
const id = (suffix: string) => `01990000-0000-7000-8000-00000000${suffix}`
const SPACE = id('2101')
const USER = id('2102')
const MEMBERSHIP = id('2103')
const OTHER_USER = id('2116')
const OTHER_USER_MEMBERSHIP = id('2117')
const PROJECT = id('2104')
const MACHINE = id('2105')
const OTHER_MACHINE = id('2113')
const OTHER_USER_MACHINE = id('2118')
const OTHER_SPACE = id('2114')
const OTHER_MEMBERSHIP = id('2115')
const TASK = id('2106')
const FLOW = id('2107')
const STAGE = id('2108')
const WORKFLOW = id('2109')
const WORKFLOW_VERSION = id('2110')
const CATALOGUE = id('2111')
const CATALOGUE_VERSION = id('2112')
const STAMP = '2026-11-03T12:00:00.000Z'
const OBLIGATION = id('2119')
const TEXT = id('2120')
const COPY = id('2121')
const UNKNOWN = id('2122')
const OTHER_PROJECT = id('2123')

const payload = (kind: 'task_flow' | 'task_flow_stage') =>
  Object.fromEntries(OUTBOX_PAYLOAD_CONTRACTS[kind].columns.map((column) => [column, null]))

function flowPayload(revision = 1, state = 'open') {
  return Object.assign(payload('task_flow'), {
    id: FLOW,
    spaceId: SPACE,
    projectId: PROJECT,
    projectName: 'task-flow-sync-proof',
    taskId: TASK,
    state,
    openStageRecordId: STAGE,
    openingMachineId: MACHINE,
    updatedMachineId: MACHINE,
    machineId: MACHINE,
    revision,
    createdAt: STAMP,
    updatedAt: STAMP,
  })
}

function stagePayload(revision = 1, state = 'running') {
  return Object.assign(payload('task_flow_stage'), {
    id: STAGE,
    spaceId: SPACE,
    projectId: PROJECT,
    projectName: 'task-flow-sync-proof',
    flowRecordId: FLOW,
    workflow: 'proof',
    mode: 'default',
    workflowKey: 'DEV-2234',
    instanceId: '',
    sessionId: 'session-proof',
    workflowVersionId: WORKFLOW_VERSION,
    catalogueVersionId: CATALOGUE_VERSION,
    arguments: { key: 'DEV-1978' },
    activeOrdinal: 0,
    activeSlug: 'build',
    state,
    closedStepNotes: [],
    question: 'Proceed?',
    autonomy: '{"level":"guided"}',
    enforcement: 'floors',
    totalSteps: 2,
    openedMachineId: MACHINE,
    takenOverFromMachineId: null,
    lastAdvancedMachineId: MACHINE,
    machineId: MACHINE,
    revision,
    createdAt: STAMP,
    updatedAt: STAMP,
  })
}

test('stage payload conversion carries the complete shape', () => {
  expect(taskFlowStageValues(stagePayload())).toMatchObject({
    projectId: PROJECT,
    workflowKey: 'DEV-2234',
    instanceId: '',
    sessionId: 'session-proof',
    question: 'Proceed?',
    autonomy: '{"level":"guided"}',
    enforcement: 'floors',
  })
})

async function push(
  actor: SQL,
  rowId: number,
  kind: 'task_flow' | 'task_flow_stage',
  value: Record<string, unknown>,
  identity: { spaceId: string; machineId: string; userId?: string } = {
    spaceId: SPACE,
    machineId: MACHINE,
  },
) {
  return syncHostedRecord({
    url: actorUrl!,
    postgres: actor,
    identity: {
      user: { id: identity.userId ?? USER },
      activeSpaceId: identity.spaceId,
      personalSpaceId: identity.spaceId,
      memberships: [
        { space_id: identity.spaceId, slug: 'task-flow-sync-proof', permission: 'write' },
      ],
    },
    request: {
      machine: { id: identity.machineId, name: 'task-flow-sync-proof', seenAt: STAMP },
      rows: [{ id: rowId, kind, payload: JSON.stringify(value), spaceHint: null }],
    },
  })
}

test('task-flow apply is idempotent and rejects older revisions', async () => {
  const postgres = new PGlite()
  try {
    await postgres.exec(`
      CREATE TABLE task_flow (
        id uuid PRIMARY KEY, space_id uuid NOT NULL, project_id uuid NOT NULL,
        task_id uuid NOT NULL, state text NOT NULL, open_stage_record_id uuid,
        opening_machine_id uuid NOT NULL, updated_machine_id uuid NOT NULL,
        revision integer NOT NULL, last_request_id uuid,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
      );
      CREATE TABLE task_flow_stage (
        id uuid PRIMARY KEY, space_id uuid NOT NULL, flow_record_id uuid NOT NULL,
        project_id uuid, number integer, workflow_key text, instance_id text, session_id text,
        workflow text NOT NULL, mode text NOT NULL, workflow_version_id uuid NOT NULL,
        catalogue_version_id uuid NOT NULL, arguments jsonb NOT NULL,
        active_ordinal integer NOT NULL, active_slug text NOT NULL, state text NOT NULL,
        closed_step_notes jsonb NOT NULL, question text, autonomy text, enforcement text,
        total_steps integer NOT NULL,
        opened_machine_id uuid NOT NULL, taken_over_from_machine_id uuid,
        last_advanced_machine_id uuid NOT NULL, revision integer NOT NULL, last_request_id uuid,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
      );
    `)
    const database = drizzle({ client: postgres })
    const applyFlow = (value: Record<string, unknown>) =>
      applyTaskFlowValues(
        database as unknown as Parameters<typeof applyTaskFlowValues>[0],
        taskFlowValues(value),
      )
    const applyStage = (value: Record<string, unknown>, number: number | null = null) =>
      applyTaskFlowStageValues(
        database as unknown as Parameters<typeof applyTaskFlowStageValues>[0],
        taskFlowStageValues(value),
        number,
      )

    await applyFlow(flowPayload())
    await applyFlow(flowPayload())
    await applyStage(stagePayload(), 7)
    await applyStage(stagePayload())
    expect(
      (
        await postgres.query(
          'SELECT (SELECT count(*)::int FROM task_flow) flows, (SELECT count(*)::int FROM task_flow_stage) stages',
        )
      ).rows,
    ).toEqual([{ flows: 1, stages: 1 }])

    await applyFlow(flowPayload(2, 'done'))
    await applyStage(stagePayload(2, 'done'))
    await applyStage(
      {
        ...stagePayload(3, 'done'),
        flowRecordId: UNKNOWN,
        projectId: OTHER_PROJECT,
      },
      99,
    )
    await applyFlow(flowPayload(1, 'open'))
    await applyStage(stagePayload(1, 'running'))
    expect(
      (
        await postgres.query(
          `SELECT flow.state flow_state,flow.revision flow_revision,
                  stage.state stage_state,stage.revision stage_revision,
                  stage.flow_record_id stage_flow_record_id,
                  stage.project_id stage_project_id,stage.number stage_number
           FROM task_flow flow JOIN task_flow_stage stage ON stage.flow_record_id=flow.id`,
        )
      ).rows,
    ).toEqual([
      {
        flow_state: 'done',
        flow_revision: 2,
        stage_state: 'done',
        stage_revision: 3,
        stage_flow_record_id: FLOW,
        stage_project_id: PROJECT,
        stage_number: 7,
      },
    ])
  } finally {
    await postgres.close()
  }
})

realPostgres('hosted task flow revisions', () => {
  test('duplicate payloads stay singular and older flow and stage revisions cannot overwrite', async () => {
    const admin = new SQL(adminUrl!)
    const actor = new SQL(actorUrl!)
    try {
      await admin`INSERT INTO space(id,name,slug,created_at)
        VALUES (${SPACE}::uuid,'Task flow sync proof','task-flow-sync-proof',now())`
      await admin`INSERT INTO space(id,name,slug,created_at)
        VALUES (${OTHER_SPACE}::uuid,'Other task flow space','other-task-flow-space',now())`
      await admin`INSERT INTO "user"(id,email,name,created_at)
        VALUES (${USER}::uuid,'task-flow-sync-proof@example.test','Task flow proof',now())`
      await admin`INSERT INTO "user"(id,email,name,created_at)
        VALUES (${OTHER_USER}::uuid,'other-task-flow-sync-proof@example.test','Other task flow proof',now())`
      await admin`INSERT INTO membership(id,space_id,user_id,role,permission,created_at)
        VALUES (${MEMBERSHIP}::uuid,${SPACE}::uuid,${USER}::uuid,'member','write',now())`
      await admin`INSERT INTO membership(id,space_id,user_id,role,permission,created_at)
        VALUES (${OTHER_MEMBERSHIP}::uuid,${OTHER_SPACE}::uuid,${USER}::uuid,'member','write',now())`
      await admin`INSERT INTO membership(id,space_id,user_id,role,permission,created_at)
        VALUES (${OTHER_USER_MEMBERSHIP}::uuid,${SPACE}::uuid,${OTHER_USER}::uuid,'member','write',now())`
      await admin`INSERT INTO project(id,space_id,name,key_prefixes,created_at)
        VALUES (${PROJECT}::uuid,${SPACE}::uuid,'task-flow-sync-proof',ARRAY['DEV'],now())`
      await admin`INSERT INTO machine(id,user_id,name,registered_at,last_seen)
        VALUES (${MACHINE}::uuid,${USER}::uuid,'task-flow-sync-proof',now(),now())`
      await admin`INSERT INTO machine(id,user_id,name,registered_at,last_seen)
        VALUES (${OTHER_MACHINE}::uuid,${USER}::uuid,'task-flow-sync-proof-other',now(),now())`
      await admin`INSERT INTO machine(id,user_id,name,registered_at,last_seen)
        VALUES (${OTHER_USER_MACHINE}::uuid,${OTHER_USER}::uuid,'other-user-task-flow-sync-proof',now(),now())`
      await admin`INSERT INTO hub_task
        (id,space_id,project_name,project_id,key,project,title,status,status_category,source,
         first_seen,last_seen,created_at,updated_at)
        VALUES (${TASK}::uuid,${SPACE}::uuid,'task-flow-sync-proof',${PROJECT}::uuid,'DEV-1978',
          'task-flow-sync-proof','Proof','active','active','local',now(),now(),now(),now())`
      await admin`INSERT INTO workflow(id,space_id,slug,created_at,updated_at)
        VALUES (${WORKFLOW}::uuid,${SPACE}::uuid,'proof',now(),now())`
      await admin`INSERT INTO workflow_version
        (id,space_id,workflow_id,n,status,definition,author,reason,created_at,updated_at)
        VALUES (${WORKFLOW_VERSION}::uuid,${SPACE}::uuid,${WORKFLOW}::uuid,1,'production','{}',
          'test','proof',now(),now())`
      await admin`INSERT INTO step_catalogue(id,space_id,slug,created_at,updated_at)
        VALUES (${CATALOGUE}::uuid,${SPACE}::uuid,'shared',now(),now())`
      await admin`INSERT INTO step_catalogue_version
        (id,space_id,catalogue_id,n,status,definition,author,reason,created_at,updated_at)
        VALUES (${CATALOGUE_VERSION}::uuid,${SPACE}::uuid,${CATALOGUE}::uuid,1,'production','{}',
          'test','proof',now(),now())`

      await push(actor, 1, 'task_flow', flowPayload())
      await push(actor, 2, 'task_flow', flowPayload())
      const otherMachineStage = stagePayload()
      Object.assign(otherMachineStage, {
        openedMachineId: OTHER_MACHINE,
        lastAdvancedMachineId: OTHER_MACHINE,
        machineId: OTHER_MACHINE,
      })
      expect(
        await push(actor, 3, 'task_flow_stage', otherMachineStage, {
          spaceId: SPACE,
          machineId: OTHER_MACHINE,
        }),
      ).toMatchObject({ results: [{ id: 3, status: 'synced' }] })
      await push(actor, 4, 'task_flow_stage', stagePayload())
      expect(
        await admin<{ flows: number; stages: number }[]>`
          SELECT (SELECT count(*)::int FROM task_flow WHERE id=${FLOW}::uuid) flows,
                 (SELECT count(*)::int FROM task_flow_stage WHERE id=${STAGE}::uuid) stages`,
      ).toEqual([{ flows: 1, stages: 1 }])

      const oldStagePayload = stagePayload(2, 'done')
      for (const field of [
        'projectId',
        'workflowKey',
        'instanceId',
        'sessionId',
        'question',
        'autonomy',
        'enforcement',
      ])
        delete oldStagePayload[field]
      expect(await push(actor, 12, 'task_flow_stage', oldStagePayload)).toMatchObject({
        results: [{ id: 12, status: 'synced' }],
      })
      expect(
        await admin<
          {
            project_id: string
            workflow_key: string | null
            instance_id: string | null
            session_id: string | null
            question: string | null
            autonomy: string | null
            enforcement: string | null
          }[]
        >`SELECT project_id,workflow_key,instance_id,session_id,question,autonomy,enforcement
           FROM task_flow_stage WHERE id=${STAGE}::uuid`,
      ).toEqual([
        {
          project_id: PROJECT,
          workflow_key: null,
          instance_id: null,
          session_id: null,
          question: null,
          autonomy: null,
          enforcement: null,
        },
      ])

      await push(actor, 5, 'task_flow', flowPayload(2, 'done'))
      await push(actor, 6, 'task_flow_stage', stagePayload(2, 'done'))
      await push(actor, 7, 'task_flow', flowPayload(1, 'open'))
      await push(actor, 8, 'task_flow_stage', stagePayload(1, 'running'))
      expect(
        await admin<
          {
            flow_state: string
            flow_revision: number
            stage_state: string
            stage_revision: number
          }[]
        >`
          SELECT flow.state flow_state,flow.revision flow_revision,
                 stage.state stage_state,stage.revision stage_revision
          FROM task_flow flow JOIN task_flow_stage stage ON stage.flow_record_id=flow.id
          WHERE flow.id=${FLOW}::uuid`,
      ).toEqual([{ flow_state: 'done', flow_revision: 2, stage_state: 'done', stage_revision: 2 }])

      const takeover = flowPayload(3, 'open')
      Object.assign(takeover, { updatedMachineId: OTHER_MACHINE, machineId: OTHER_MACHINE })
      expect(
        await push(actor, 9, 'task_flow', takeover, {
          spaceId: SPACE,
          machineId: OTHER_MACHINE,
        }),
      ).toMatchObject({ results: [{ id: 9, status: 'synced' }] })

      const foreignSpace = flowPayload(4, 'done')
      Object.assign(foreignSpace, {
        spaceId: OTHER_SPACE,
        updatedMachineId: OTHER_MACHINE,
        machineId: OTHER_MACHINE,
      })
      const refused = await push(actor, 10, 'task_flow', foreignSpace, {
        spaceId: OTHER_SPACE,
        machineId: OTHER_MACHINE,
      })
      expect(refused.results[0]).toMatchObject({
        id: 10,
        status: 'quarantined',
      })

      const foreignPrincipal = flowPayload(4, 'done')
      Object.assign(foreignPrincipal, {
        updatedMachineId: OTHER_USER_MACHINE,
        machineId: OTHER_USER_MACHINE,
      })
      const principalRefused = await push(actor, 11, 'task_flow', foreignPrincipal, {
        spaceId: SPACE,
        machineId: OTHER_USER_MACHINE,
        userId: OTHER_USER,
      })
      expect(principalRefused.results[0]).toMatchObject({
        id: 11,
        status: 'quarantined',
      })

      await admin`UPDATE task_flow_stage SET number=7 WHERE id=${STAGE}::uuid`
      await admin`INSERT INTO workflow_obligation
        (id,space_id,stage_record_id,step_ordinal,step_slug,floor,require_pull_request,
         expected_exit_code,expected_status,floor_deferrable,reason,session_id,created_at,
         operator_ruling)
        VALUES (${OBLIGATION}::uuid,${SPACE}::uuid,${STAGE}::uuid,1,'build','test',false,
          0,'done',true,'proof','session-proof',${STAMP},false)`
      await admin`INSERT INTO workflow_step_text
        (id,space_id,stage_record_id,step_ordinal,step_slug,body,created_at)
        VALUES (${TEXT}::uuid,${SPACE}::uuid,${STAGE}::uuid,1,'build','proof text',${STAMP})`
      await admin`INSERT INTO workflow_text_copy
        (id,space_id,workflow_text_record_id,stage_record_id,task_document_reference,copied_at)
        VALUES (${COPY}::uuid,${SPACE}::uuid,${TEXT}::uuid,${STAGE}::uuid,'task:DEV-1978',${STAMP})`

      const principal = { url: actorUrl!, userId: USER, spaceId: SPACE }
      await expect(readRecordTaskFlowStage({ ...principal, id: STAGE })).resolves.toMatchObject({
        stage: {
          id: STAGE,
          number: 7,
          obligations: [{ id: OBLIGATION }],
          stepTexts: [{ id: TEXT }],
          textCopies: [{ id: COPY }],
        },
        flow: { id: FLOW },
      })
      await expect(readRecordTaskFlowText({ ...principal, id: TEXT })).resolves.toMatchObject({
        text: { id: TEXT, stageRecordId: STAGE, stepSlug: 'build', body: 'proof text' },
        stage: { id: STAGE, number: 7 },
        copy: { id: COPY, taskDocumentReference: 'task:DEV-1978' },
      })
      await expect(
        readRecordTaskFlowObligation({ ...principal, id: OBLIGATION }),
      ).resolves.toMatchObject({
        obligation: { id: OBLIGATION, stageRecordId: STAGE, floor: 'test' },
        stage: { id: STAGE, number: 7, state: 'done' },
      })

      for (const [read, knownId] of [
        [readRecordTaskFlowStage, STAGE],
        [readRecordTaskFlowText, TEXT],
        [readRecordTaskFlowObligation, OBLIGATION],
      ] as const)
        for (const input of [
          { ...principal, id: UNKNOWN },
          { ...principal, spaceId: OTHER_SPACE, id: knownId },
        ])
          await expect(read(input)).rejects.toMatchObject({
            status: 404,
            code: 'task_flow_not_found',
          })
    } finally {
      await admin`DELETE FROM task_flow_stage WHERE id=${STAGE}::uuid`
      await admin`DELETE FROM task_flow WHERE id=${FLOW}::uuid`
      await admin`DELETE FROM workflow_version WHERE id=${WORKFLOW_VERSION}::uuid`
      await admin`DELETE FROM workflow WHERE id=${WORKFLOW}::uuid`
      await admin`DELETE FROM step_catalogue_version WHERE id=${CATALOGUE_VERSION}::uuid`
      await admin`DELETE FROM step_catalogue WHERE id=${CATALOGUE}::uuid`
      await admin`DELETE FROM hub_task WHERE id=${TASK}::uuid`
      await admin`DELETE FROM machine_name_claim WHERE machine_id=${MACHINE}::uuid`
      await admin`DELETE FROM machine_name_claim WHERE machine_id=${OTHER_MACHINE}::uuid`
      await admin`DELETE FROM machine_name_claim WHERE machine_id=${OTHER_USER_MACHINE}::uuid`
      await admin`DELETE FROM machine WHERE id=${MACHINE}::uuid`
      await admin`DELETE FROM machine WHERE id=${OTHER_MACHINE}::uuid`
      await admin`DELETE FROM machine WHERE id=${OTHER_USER_MACHINE}::uuid`
      await admin`DELETE FROM routing_evidence_head WHERE space_id=${SPACE}::uuid`
      await admin`DELETE FROM project WHERE id=${PROJECT}::uuid`
      await admin`DELETE FROM membership WHERE id=${MEMBERSHIP}::uuid`
      await admin`DELETE FROM membership WHERE id=${OTHER_MEMBERSHIP}::uuid`
      await admin`DELETE FROM membership WHERE id=${OTHER_USER_MEMBERSHIP}::uuid`
      await admin`DELETE FROM space WHERE id=${SPACE}::uuid`
      await admin`DELETE FROM space WHERE id=${OTHER_SPACE}::uuid`
      await admin`DELETE FROM "user" WHERE id=${USER}::uuid`
      await admin`DELETE FROM "user" WHERE id=${OTHER_USER}::uuid`
      await Promise.all([actor.close(), admin.close()])
    }
  })
})
