import { expect, test } from 'bun:test'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { rememberProjectSpace } from '../project-space-cache.ts'
import type { HostedTaskFlowStageById } from '../record/record-task-flow-contract.ts'
import { recordTaskFlowReadStore } from './task-flow-store-record.ts'
import { sqliteTaskFlowReadStore } from './task-flow-store-sqlite.ts'

const PROJECT_ID = '00000000-0000-4000-8000-000000000001'
const FLOW_ID = '00000000-0000-4000-8000-000000000002'
const TASK_ID = '00000000-0000-4000-8000-000000000003'
const MACHINE_ID = '00000000-0000-4000-8000-000000000004'
const WORKFLOW_VERSION_ID = '00000000-0000-4000-8000-000000000005'
const CATALOGUE_VERSION_ID = '00000000-0000-4000-8000-000000000006'
const WORKFLOW_ID = '00000000-0000-4000-8000-000000000010'
const CATALOGUE_ID = '00000000-0000-4000-8000-000000000011'

const database = testDatabaseFixture((d) => {
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
  rememberProjectSpace(d, 'fixture', 'fixture-space')
})

function hostedStage(input: { taskless?: boolean; number?: number } = {}): HostedTaskFlowStageById {
  const number = input.number ?? 1
  const stageId = `00000000-0000-4000-8000-00000000000${number + 6}`
  return {
    flow: {
      id: input.taskless ? '00000000-0000-4000-8000-000000000009' : FLOW_ID,
      projectId: PROJECT_ID,
      taskId: input.taskless ? null : TASK_ID,
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
      flowRecordId: input.taskless ? '00000000-0000-4000-8000-000000000009' : FLOW_ID,
      projectId: PROJECT_ID,
      projectName: 'fixture',
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
      obligations: [],
      stepTexts: [],
      textCopies: [],
    },
  }
}

test('record adapter matches SQLite rows and normalizes taskless stages', async () => {
  const d = database()
  const local = sqliteTaskFlowReadStore(d)
  const hosted = recordTaskFlowReadStore(
    d,
    createMemoryRecordApiClient({ taskFlowStages: [hostedStage()], taskFlowPageSize: 1 }),
  )
  expect(await hosted.stageByHandle('fixture', 1)).toEqual(await local.stageByHandle('fixture', 1))
  expect(await hosted.openStageForTask(TASK_ID)).toEqual(await local.openStageForTask(TASK_ID))
  expect(await hosted.flowProjectionForTask(TASK_ID)).toEqual(
    await local.flowProjectionForTask(TASK_ID),
  )
  expect(await hosted.openStageWorktrees()).toEqual(await local.openStageWorktrees())
  const stageId = hostedStage().stage.id
  const input = { project: 'fixture', workflow: 'flow', mode: 'default', taskRecordId: TASK_ID }
  const assertions = [
    [hosted.stageByRecordId(stageId), local.stageByRecordId(stageId)],
    [hosted.latestStageForTask(input), local.latestStageForTask(input)],
    [
      hosted.openKeylessStages({
        project: 'fixture',
        workflow: 'flow',
        mode: 'default',
        sessionId: 'session-a',
        untouched: false,
      }),
      local.openKeylessStages({
        project: 'fixture',
        workflow: 'flow',
        mode: 'default',
        sessionId: 'session-a',
        untouched: false,
      }),
    ],
    [
      hosted.activeStageModes({ ...input, key: 'DEV-2234', sessionId: 'session-a' }),
      local.activeStageModes({ ...input, key: 'DEV-2234', sessionId: 'session-a' }),
    ],
    [hosted.activeStageAutonomy('fixture', TASK_ID), local.activeStageAutonomy('fixture', TASK_ID)],
    [hosted.stageIdentityMap(), local.stageIdentityMap()],
    [
      hosted.stageHoldingTaskKey({
        project: 'fixture',
        workflow: 'flow',
        mode: 'default',
        key: 'DEV-2234',
      }),
      local.stageHoldingTaskKey({
        project: 'fixture',
        workflow: 'flow',
        mode: 'default',
        key: 'DEV-2234',
      }),
    ],
    [hosted.flowState(FLOW_ID), local.flowState(FLOW_ID)],
    [hosted.textsForStage(stageId), local.textsForStage(stageId)],
    [hosted.textByRecordId('missing-text'), local.textByRecordId('missing-text')],
    [
      hosted.textAttachmentByRecordId('missing-text'),
      local.textAttachmentByRecordId('missing-text'),
    ],
    [hosted.textRecordIdsForStage(stageId), local.textRecordIdsForStage(stageId)],
    [hosted.copiedTextRecordIdsForStage(stageId), local.copiedTextRecordIdsForStage(stageId)],
    [hosted.stageProject(stageId), local.stageProject(stageId)],
    [hosted.uncopiedTextsForStage(stageId), local.uncopiedTextsForStage(stageId)],
    [hosted.liveTextAttachment('missing-text'), local.liveTextAttachment('missing-text')],
    [hosted.copiedTextReference('missing-text'), local.copiedTextReference('missing-text')],
    [hosted.openObligationRecordIds(stageId), local.openObligationRecordIds(stageId)],
    [hosted.openObligations(stageId), local.openObligations(stageId)],
    [
      hosted.obligationByRecordId('missing-obligation'),
      local.obligationByRecordId('missing-obligation'),
    ],
    [
      hosted.nextKeylessInstanceSlot({
        projectRecordId: PROJECT_ID,
        workflow: 'flow',
        mode: 'default',
        sessionId: 'session-a',
        machineId: MACHINE_ID,
      }),
      local.nextKeylessInstanceSlot({
        projectRecordId: PROJECT_ID,
        workflow: 'flow',
        mode: 'default',
        sessionId: 'session-a',
        machineId: MACHINE_ID,
      }),
    ],
    [hosted.flowForTask(TASK_ID), local.flowForTask(TASK_ID)],
    [hosted.hasStage(stageId), local.hasStage(stageId)],
    [
      hosted.stagesNeedingTaskLink('fixture', 'DEV-2234'),
      local.stagesNeedingTaskLink('fixture', 'DEV-2234'),
    ],
    [
      hosted.unlinkedLabelHolder({
        project: 'fixture',
        workflow: 'flow',
        mode: 'default',
        key: 'DEV-2234',
      }),
      local.unlinkedLabelHolder({
        project: 'fixture',
        workflow: 'flow',
        mode: 'default',
        key: 'DEV-2234',
      }),
    ],
    [hosted.pendingTaskLinks('workflow_cursor'), local.pendingTaskLinks('workflow_cursor')],
    [hosted.linkedTaskReferences('workflow_cursor'), local.linkedTaskReferences('workflow_cursor')],
    [hosted.projectReferenceCounts(PROJECT_ID), local.projectReferenceCounts(PROJECT_ID)],
  ]
  for (const [recordAnswer, localAnswer] of assertions)
    expect(await recordAnswer).toEqual(await localAnswer)

  const taskless = recordTaskFlowReadStore(
    d,
    createMemoryRecordApiClient({ taskFlowStages: [hostedStage({ taskless: true, number: 2 })] }),
  )
  expect((await taskless.stageByHandle('fixture', 2))?.task_flow_record_id).toBeNull()
})

test('record adapter reads every page and applies linked and machine filters', async () => {
  const d = database()
  const stages = [hostedStage(), hostedStage({ taskless: true, number: 2 })]
  const store = recordTaskFlowReadStore(
    d,
    createMemoryRecordApiClient({ taskFlowStages: stages, taskFlowPageSize: 1 }),
  )
  expect(await store.openStageWorktrees()).toHaveLength(2)
  expect(await store.linkedTaskReferences('workflow_cursor')).toEqual([
    { task_record_id: TASK_ID, project: 'fixture' },
  ])
  expect(
    await store.nextKeylessInstanceSlot({
      projectRecordId: PROJECT_ID,
      workflow: 'flow',
      mode: 'default',
      sessionId: null,
      machineId: MACHINE_ID,
    }),
  ).toBe(2)
})

test('record adapter refuses a failed page without returning a prefix', async () => {
  const store = recordTaskFlowReadStore(
    database(),
    createMemoryRecordApiClient({
      taskFlowStages: [hostedStage(), hostedStage({ taskless: true, number: 2 })],
      taskFlowPageSize: 1,
      taskFlowFailedPage: 2,
    }),
  )
  await expect(store.openStageWorktrees()).rejects.toThrow(
    'hosted task-flow stage list page 2 failed',
  )
})
