import type { Database } from 'bun:sqlite'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { rememberProjectSpace } from '../project-space-cache.ts'
import type { HostedTaskFlowStageById } from '../record/record-task-flow-contract.ts'

export const PROJECT_ID = '00000000-0000-4000-8000-000000000001'
export const FLOW_ID = '00000000-0000-4000-8000-000000000002'
export const TASK_ID = '00000000-0000-4000-8000-000000000003'
export const MACHINE_ID = '00000000-0000-4000-8000-000000000004'
export const WORKFLOW_VERSION_ID = '00000000-0000-4000-8000-000000000005'
export const CATALOGUE_VERSION_ID = '00000000-0000-4000-8000-000000000006'
const WORKFLOW_ID = '00000000-0000-4000-8000-000000000010'
const CATALOGUE_ID = '00000000-0000-4000-8000-000000000011'
export const TEXT_ID = '00000000-0000-4000-8000-000000000012'
const COPY_ID = '00000000-0000-4000-8000-000000000013'
export const OBLIGATION_ID = '00000000-0000-4000-8000-000000000014'
export const CHILD_FLOW_ID = '00000000-0000-4000-8000-000000000015'
export const ABANDONED_STAGE_ID = '00000000-0000-4000-8000-000000000016'
export const CHILD_STAGE_ID = '00000000-0000-4000-8000-000000000017'

function seedDefinitions(d: Database) {
  d.query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)').run(
    PROJECT_ID,
    'fixture',
    '/fixture',
    'bun',
    JSON.stringify({ space: 'fixture' }),
  )
  d.query('INSERT INTO workflow (record_id,slug,created_at) VALUES (?,?,?)').run(
    WORKFLOW_ID,
    'flow',
    '2026-11-12T00:00:00.000Z',
  )
  d.query(
    `INSERT INTO workflow_version
     (record_id,workflow_record_id,n,status,definition,author,reason,created_at)
     VALUES (?,?,1,'production','{}','test','fixture',?)`,
  ).run(WORKFLOW_VERSION_ID, WORKFLOW_ID, '2026-11-12T00:00:00.000Z')
  d.query('INSERT INTO step_catalogue (record_id,slug,created_at) VALUES (?,?,?)').run(
    CATALOGUE_ID,
    'shared',
    '2026-11-12T00:00:00.000Z',
  )
  d.query(
    `INSERT INTO step_catalogue_version
     (record_id,catalogue_record_id,n,status,definition,author,reason,created_at)
     VALUES (?,?,1,'production','{}','test','fixture',?)`,
  ).run(CATALOGUE_VERSION_ID, CATALOGUE_ID, '2026-11-12T00:00:00.000Z')
}

function seedFlow(d: Database) {
  d.query(
    `INSERT INTO task_flow
     (record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,created_at,
      updated_at,opening_machine_id,updated_machine_id,revision)
     VALUES (?,?,?,?,NULL,?,?,?,?,?)`,
  ).run(
    FLOW_ID,
    TASK_ID,
    PROJECT_ID,
    'open',
    '2026-11-12T00:00:00.000Z',
    '2026-11-12T00:00:00.000Z',
    MACHINE_ID,
    MACHINE_ID,
    1,
  )
  d.query(
    `INSERT INTO workflow_cursor
     (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,
      task_record_id,task_flow_record_id,instance_id,session_id,workflow_version_record_id,
      catalogue_version_record_id,args,autonomy,ordinal,step_slug,state,closed,question,total_steps,
      created_at,updated_at,enforcement,opened_machine_id,last_advanced_machine_id,revision)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    '00000000-0000-4000-8000-000000000007',
    1,
    'fixture',
    PROJECT_ID,
    'flow',
    'default',
    'DEV-2234',
    TASK_ID,
    FLOW_ID,
    '',
    'session-a',
    WORKFLOW_VERSION_ID,
    CATALOGUE_VERSION_ID,
    '{}',
    'guided',
    0,
    'plan',
    'running',
    '[]',
    null,
    2,
    '2026-11-12T00:00:00.000Z',
    '2026-11-12T00:00:00.000Z',
    'floors',
    MACHINE_ID,
    MACHINE_ID,
    1,
  )
  d.query('UPDATE task_flow SET open_stage_cursor_record_id=? WHERE record_id=?').run(
    '00000000-0000-4000-8000-000000000007',
    FLOW_ID,
  )
}

function seedStageRows(d: Database) {
  d.query(
    `INSERT INTO workflow_step_text
     (record_id,cursor_record_id,step_ordinal,step_slug,body,created_at) VALUES (?,?,?,?,?,?)`,
  ).run(
    TEXT_ID,
    '00000000-0000-4000-8000-000000000007',
    0,
    'plan',
    'fixture text',
    '2026-11-12T00:00:00.000Z',
  )
  d.query(
    `INSERT INTO workflow_text_copy
     (record_id,workflow_text_record_id,cursor_record_id,task_document_reference,copied_at)
     VALUES (?,?,?,?,?)`,
  ).run(
    COPY_ID,
    TEXT_ID,
    '00000000-0000-4000-8000-000000000007',
    'task:DEV-2234/doc',
    '2026-11-12T00:00:00.000Z',
  )
  d.query(
    `INSERT INTO workflow_obligation
     (record_id,cursor_record_id,step_ordinal,step_slug,floor,require_pull_request,
      operator_ruling,expected_exit_code,expected_status,floor_deferrable,reason,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    OBLIGATION_ID,
    '00000000-0000-4000-8000-000000000007',
    0,
    'plan',
    'command-exit',
    1,
    0,
    0,
    'done',
    1,
    'fixture obligation',
    '2026-11-12T00:00:00.000Z',
  )
}

export const database = testDatabaseFixture((d) => {
  seedDefinitions(d)
  seedFlow(d)
  seedStageRows(d)
  rememberProjectSpace(d, 'fixture', 'fixture-space')
})

type HostedObligation = HostedTaskFlowStageById['stage']['obligations'][number]

function hostedObligation(stageId: string): HostedObligation {
  return {
    id: OBLIGATION_ID,
    stageRecordId: stageId,
    stepOrdinal: 0,
    stepSlug: 'plan',
    floor: 'command-exit',
    requirePullRequest: true,
    expectedExitCode: 0,
    expectedStatus: 'done',
    floorDeferrable: true,
    reason: 'fixture obligation',
    sessionId: null,
    createdAt: '2026-11-12T00:00:00.000Z',
    satisfiedAt: null,
    satisfiedStepOrdinal: null,
    satisfiedStepSlug: null,
    satisfiedEvidence: null,
    abandonedAt: null,
    abandonedReason: null,
    operatorRuling: false,
  }
}

export function hostedStage(
  input: {
    taskless?: boolean
    number?: number
    stageId?: string
    flowId?: string
    projectId?: string
    projectName?: string
    taskId?: string
  } = {},
): HostedTaskFlowStageById {
  const number = input.number ?? 1
  const stageId = input.stageId ?? `00000000-0000-4000-8000-00000000000${number + 6}`
  const flowId = input.flowId ?? (input.taskless ? '00000000-0000-4000-8000-000000000009' : FLOW_ID)
  const projectId = input.projectId ?? PROJECT_ID
  return {
    flow: {
      id: flowId,
      projectId,
      taskId: input.taskless ? null : (input.taskId ?? TASK_ID),
      taskKey: input.taskless ? null : 'DEV-2234',
      state: 'open',
      openStageRecordId: stageId,
      openStageCount: 1,
      openingMachineId: MACHINE_ID,
      updatedMachineId: MACHINE_ID,
      revision: 1,
      createdAt: '2026-11-12T00:00:00.000Z',
      updatedAt: '2026-11-12T00:00:00.000Z',
    },
    stage: {
      id: stageId,
      flowRecordId: flowId,
      projectId,
      projectName: input.projectName ?? 'fixture',
      number,
      workflow: 'flow',
      mode: 'default',
      workflowKey: input.taskless ? '' : 'DEV-2234',
      instanceId: '',
      sessionId: 'session-a',
      workflowVersionId: WORKFLOW_VERSION_ID,
      workflowVersionNumber: 1,
      catalogueVersionId: CATALOGUE_VERSION_ID,
      catalogueVersionNumber: 1,
      arguments: {},
      activeOrdinal: 0,
      activeSlug: 'plan',
      state: 'running',
      closedStepNotes: [],
      question: null,
      autonomy: 'guided',
      enforcement: 'floors',
      totalSteps: 2,
      openedMachineId: MACHINE_ID,
      takenOverFromMachineId: null,
      lastAdvancedMachineId: MACHINE_ID,
      revision: 1,
      createdAt: '2026-11-12T00:00:00.000Z',
      updatedAt: '2026-11-12T00:00:00.000Z',
      obligations: [hostedObligation(stageId)],
      stepTexts: [
        {
          id: TEXT_ID,
          stageRecordId: stageId,
          stepOrdinal: 0,
          stepSlug: 'plan',
          body: 'fixture text',
          createdAt: '2026-11-12T00:00:00.000Z',
        },
      ],
      textCopies: [
        {
          id: COPY_ID,
          workflowTextRecordId: TEXT_ID,
          stageRecordId: stageId,
          taskDocumentReference: 'task:DEV-2234/doc',
          copiedAt: '2026-11-12T00:00:00.000Z',
        },
      ],
    },
  }
}
