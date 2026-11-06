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
    workflowVersionId: WORKFLOW_VERSION,
    catalogueVersionId: CATALOGUE_VERSION,
    arguments: { key: 'DEV-1978' },
    activeOrdinal: 0,
    activeSlug: 'build',
    state,
    closedStepNotes: [],
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
        revision integer NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
      );
      CREATE TABLE task_flow_stage (
        id uuid PRIMARY KEY, space_id uuid NOT NULL, flow_record_id uuid NOT NULL,
        workflow text NOT NULL, mode text NOT NULL, workflow_version_id uuid NOT NULL,
        catalogue_version_id uuid NOT NULL, arguments jsonb NOT NULL,
        active_ordinal integer NOT NULL, active_slug text NOT NULL, state text NOT NULL,
        closed_step_notes jsonb NOT NULL, total_steps integer NOT NULL,
        opened_machine_id uuid NOT NULL, taken_over_from_machine_id uuid,
        last_advanced_machine_id uuid NOT NULL, revision integer NOT NULL,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
      );
    `)
    const database = drizzle({ client: postgres })
    const applyFlow = (value: Record<string, unknown>) =>
      applyTaskFlowValues(
        database as unknown as Parameters<typeof applyTaskFlowValues>[0],
        taskFlowValues(value),
      )
    const applyStage = (value: Record<string, unknown>) =>
      applyTaskFlowStageValues(
        database as unknown as Parameters<typeof applyTaskFlowStageValues>[0],
        taskFlowStageValues(value),
      )

    await applyFlow(flowPayload())
    await applyFlow(flowPayload())
    await applyStage(stagePayload())
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
    await applyFlow(flowPayload(1, 'open'))
    await applyStage(stagePayload(1, 'running'))
    expect(
      (
        await postgres.query(
          `SELECT flow.state flow_state,flow.revision flow_revision,
                  stage.state stage_state,stage.revision stage_revision
           FROM task_flow flow JOIN task_flow_stage stage ON stage.flow_record_id=flow.id`,
        )
      ).rows,
    ).toEqual([{ flow_state: 'done', flow_revision: 2, stage_state: 'done', stage_revision: 2 }])
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
