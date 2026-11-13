import { expect, test } from 'bun:test'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { ensureMachineIdentity } from '../database/db.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { rememberProjectSpace } from '../project-space-cache.ts'
import type { RecordPayload } from '../record/record-sync-contract.ts'
import type { HostedTaskFlowStageById } from '../record/record-task-flow-contract.ts'
import { backfillTaskFlowRecords } from './task-flow-backfill.ts'
import { recordTaskFlowReadStore } from './task-flow-store-record.ts'
import { STAGE_BY_ID_READ_LIMIT } from './task-flow-store-record-questions.ts'
import { sqliteTaskFlowReadStore } from './task-flow-store-sqlite.ts'

const PROJECT_ID = '00000000-0000-4000-8000-000000000001'
const FLOW_ID = '00000000-0000-4000-8000-000000000002'
const TASK_ID = '00000000-0000-4000-8000-000000000003'
const MACHINE_ID = '00000000-0000-4000-8000-000000000004'
const WORKFLOW_VERSION_ID = '00000000-0000-4000-8000-000000000005'
const CATALOGUE_VERSION_ID = '00000000-0000-4000-8000-000000000006'
const WORKFLOW_ID = '00000000-0000-4000-8000-000000000010'
const CATALOGUE_ID = '00000000-0000-4000-8000-000000000011'
const TEXT_ID = '00000000-0000-4000-8000-000000000012'
const COPY_ID = '00000000-0000-4000-8000-000000000013'
const OBLIGATION_ID = '00000000-0000-4000-8000-000000000014'

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
  rememberProjectSpace(d, 'fixture', 'fixture-space')
})

function hostedStage(
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
      obligations: [
        {
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
        },
      ],
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
    [hosted.textByRecordId(TEXT_ID), local.textByRecordId(TEXT_ID)],
    [hosted.textAttachmentByRecordId(TEXT_ID), local.textAttachmentByRecordId(TEXT_ID)],
    [hosted.textRecordIdsForStage(stageId), local.textRecordIdsForStage(stageId)],
    [hosted.copiedTextRecordIdsForStage(stageId), local.copiedTextRecordIdsForStage(stageId)],
    [hosted.stageProject(stageId), local.stageProject(stageId)],
    [hosted.liveTextAttachment(TEXT_ID), local.liveTextAttachment(TEXT_ID)],
    [hosted.copiedTextReference(TEXT_ID), local.copiedTextReference(TEXT_ID)],
    [hosted.openObligationRecordIds(stageId), local.openObligationRecordIds(stageId)],
    [hosted.openObligations(stageId), local.openObligations(stageId)],
    [hosted.obligationByRecordId(OBLIGATION_ID), local.obligationByRecordId(OBLIGATION_ID)],
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

test('hosted open-stage listings do not depend on mirror counterparts', async () => {
  const d = database()
  const translated = recordTaskFlowReadStore(
    d,
    createMemoryRecordApiClient({
      taskFlowStages: [
        hostedStage({ number: 71, stageId: '00000000-0000-4000-8000-000000000007' }),
      ],
    }),
  )
  expect((await translated.listOpenStages({ project: 'fixture' }))[0]!.id).toBe(71)

  const empty = recordTaskFlowReadStore(d, createMemoryRecordApiClient({ taskFlowStages: [] }))
  expect(await empty.listOpenStages({ project: 'fixture' })).toEqual([])
})

test('question-joined reads match SQLite joins and ordering', async () => {
  const d = database()
  const stageOneId = hostedStage().stage.id
  const stageTwoId = '00000000-0000-4000-8000-000000000008'
  const stageThreeId = '00000000-0000-4000-8000-000000000009'
  const insertStage = (recordId: string, number: number, key: string, taskless: boolean) =>
    d
      .query(
        `INSERT INTO workflow_cursor
       (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,
        task_record_id,task_flow_record_id,instance_id,session_id,workflow_version_record_id,
        catalogue_version_record_id,args,autonomy,ordinal,step_slug,state,closed,question,total_steps,
        created_at,updated_at,enforcement,opened_machine_id,last_advanced_machine_id,revision)
       SELECT ?,?,'fixture',project_record_id,'flow','default',?, ?, ?, ?, 'session-a',
              workflow_version_record_id,catalogue_version_record_id,'{}','guided',0,'plan','running',
              '[]',NULL,2,created_at,?,enforcement,opened_machine_id,last_advanced_machine_id,1
         FROM workflow_cursor WHERE record_id=?`,
      )
      .run(
        recordId,
        number,
        key,
        taskless ? null : TASK_ID,
        taskless ? null : FLOW_ID,
        `#${number}`,
        `2026-11-12T00:0${number}:00.000Z`,
        stageOneId,
      )
  insertStage(stageTwoId, 2, '', true)
  insertStage(stageThreeId, 3, '', true)
  d.query(
    `UPDATE workflow_cursor SET workflow_slug='ship-task',state='awaiting-ruling',
       args='{"branch":"feature"}',updated_at='2026-11-12T00:03:00.000Z'
     WHERE record_id=?`,
  ).run(stageOneId)
  d.query("UPDATE workflow_cursor SET state='awaiting-ruling' WHERE record_id=?").run(stageTwoId)

  const q1 = '00000000-0000-4000-8000-000000000031'
  const q2 = '00000000-0000-4000-8000-000000000032'
  const q3 = '00000000-0000-4000-8000-000000000033'
  d.query(
    `INSERT INTO question
     (record_id,number,workflow_cursor_record_id,workflow_key,asked_at,question)
     VALUES (?,1,?,'DEV-2234','2026-11-12T00:02:00.000Z','first?'),
            (?,2,?,'DEV-2234','2026-11-12T00:01:00.000Z','second?')`,
  ).run(q1, stageOneId, q2, stageTwoId)
  d.query(
    `INSERT INTO question
     (record_id,number,workflow_cursor_record_id,workflow_key,workflow_task_record_id,
      asked_at,question,answer,answered_at)
     VALUES (?,3,?,'DEV-2234',?,'2026-11-12T00:00:00.000Z','ruled?','yes',
             '2026-11-12T00:04:00.000Z')`,
  ).run(q3, stageTwoId, TASK_ID)

  const first = hostedStage()
  first.stage.workflow = 'ship-task'
  first.stage.state = 'awaiting-ruling'
  first.stage.arguments = { branch: 'feature' }
  first.stage.updatedAt = '2026-11-12T00:03:00.000Z'
  const second = hostedStage({ taskless: true, number: 2, stageId: stageTwoId })
  second.stage.instanceId = '#2'
  second.flow.openStageCount = 0
  second.stage.state = 'awaiting-ruling'
  second.stage.updatedAt = '2026-11-12T00:02:00.000Z'
  const third = hostedStage({ taskless: true, number: 3, stageId: stageThreeId })
  third.stage.instanceId = '#3'
  third.flow.openStageCount = 0
  third.stage.updatedAt = '2026-11-12T00:03:00.000Z'
  const local = sqliteTaskFlowReadStore(d)
  const hosted = recordTaskFlowReadStore(
    d,
    createMemoryRecordApiClient({ taskFlowStages: [third, second, first], taskFlowPageSize: 1 }),
  )

  const assertions = [
    [hosted.listOpenStages({}), local.listOpenStages({})],
    [hosted.stageIdentityMap(), local.stageIdentityMap()],
    [hosted.waitingWorkflowQuestions(), local.waitingWorkflowQuestions()],
    [
      hosted.closeOutShipTaskStage('session-a', 'fixture', 'feature'),
      local.closeOutShipTaskStage('session-a', 'fixture', 'feature'),
    ],
    [hosted.cursorWorkForSession('session-a'), local.cursorWorkForSession('session-a')],
    [hosted.cursorLifecycleForSession('session-a'), local.cursorLifecycleForSession('session-a')],
    [hosted.openStagesForSession('session-a'), local.openStagesForSession('session-a')],
    [hosted.keylessSessionCursors('fixture'), local.keylessSessionCursors('fixture')],
    [
      hosted.openWorkflowQuestionCountForSession('session-a'),
      local.openWorkflowQuestionCountForSession('session-a'),
    ],
    [hosted.workflowInboxQuestions(), local.workflowInboxQuestions()],
    [
      hosted.rulingRows({ kind: 'all', after: null, cursor: null }),
      local.rulingRows({ kind: 'all', after: null, cursor: null }),
    ],
    [hosted.rulingFileQuestion(q1), local.rulingFileQuestion(q1)],
    [hosted.questionCloseFacts(q1), local.questionCloseFacts(q1)],
    [hosted.overturnRulingRow(q3), local.overturnRulingRow(q3)],
    [hosted.pendingTaskLinks('question'), local.pendingTaskLinks('question')],
    [hosted.linkedTaskReferences('question'), local.linkedTaskReferences('question')],
    [hosted.taskRulingRows('fixture', TASK_ID, 10), local.taskRulingRows('fixture', TASK_ID, 10)],
    [hosted.localQuestionProjects(), local.localQuestionProjects()],
  ]
  for (const [recordAnswer, localAnswer] of assertions)
    expect(await recordAnswer).toEqual(await localAnswer)
})

test('question stage lookups preserve parity below and above the by-id batch limit', async () => {
  for (const stageCount of [STAGE_BY_ID_READ_LIMIT, STAGE_BY_ID_READ_LIMIT + 1]) {
    const d = database()
    const stages: HostedTaskFlowStageById[] = []
    for (let index = 0; index < stageCount; index++) {
      const number = index + 2
      const suffix = String(number).padStart(12, '0')
      const stageId = `10000000-0000-4000-8000-${suffix}`
      const questionId = `20000000-0000-4000-8000-${suffix}`
      d.query(
        `INSERT INTO workflow_cursor
         (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,
          task_record_id,task_flow_record_id,instance_id,session_id,workflow_version_record_id,
          catalogue_version_record_id,args,autonomy,ordinal,step_slug,state,closed,question,total_steps,
          created_at,updated_at,enforcement,opened_machine_id,last_advanced_machine_id,revision)
         SELECT ?,?,'fixture',project_record_id,'flow','default','DEV-2234',task_record_id,
                NULL,?,'session-a',workflow_version_record_id,
                catalogue_version_record_id,'{}','guided',0,'plan','running','[]',NULL,2,
                created_at,updated_at,enforcement,opened_machine_id,last_advanced_machine_id,1
           FROM workflow_cursor WHERE record_id='00000000-0000-4000-8000-000000000007'`,
      ).run(stageId, number, `#${number}`)
      d.query(
        `INSERT INTO question
         (record_id,number,workflow_cursor_record_id,workflow_key,asked_at,question)
         VALUES (?,?,?,'DEV-2234',?,'batch?')`,
      ).run(
        questionId,
        index + 1,
        stageId,
        `2026-11-12T00:00:${String(index).padStart(2, '0')}.000Z`,
      )
      const stage = hostedStage({ number, stageId })
      stage.stage.instanceId = `#${number}`
      stages.push(stage)
    }

    const counts = { stageLists: 0, stagesById: 0 }
    const hosted = recordTaskFlowReadStore(
      d,
      createMemoryRecordApiClient({
        taskFlowStages: stages,
        taskFlowPageSize: 7,
        taskFlowReadCounts: counts,
      }),
    )
    const local = sqliteTaskFlowReadStore(d)
    expect(await hosted.rulingRows({ kind: 'workflow', after: null, cursor: null })).toEqual(
      await local.rulingRows({ kind: 'workflow', after: null, cursor: null }),
    )
    if (stageCount === STAGE_BY_ID_READ_LIMIT) {
      expect(counts.stagesById).toBe(STAGE_BY_ID_READ_LIMIT)
      expect(counts.stageLists).toBe(0)
    } else {
      expect(counts.stagesById).toBe(0)
      expect(counts.stageLists).toBeGreaterThan(0)
    }
  }
})

test('machine-wide hosted reads merge every registered project space', async () => {
  const d = database()
  const secondProjectId = '00000000-0000-4000-8000-000000000020'
  const firstSpace = '01990000-0000-7000-8000-000000000002'
  const secondSpace = '01990000-0000-7000-8000-000000000003'
  const secondTaskId = '00000000-0000-4000-8000-000000000023'
  const secondTextId = '00000000-0000-4000-8000-000000000024'
  const secondObligationId = '00000000-0000-4000-8000-000000000025'
  d.query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)').run(
    secondProjectId,
    'second-fixture',
    '/second-fixture',
    'bun',
    JSON.stringify({ space: 'fixture-2' }),
  )
  const second = hostedStage({
    number: 1,
    stageId: '00000000-0000-4000-8000-000000000021',
    flowId: '00000000-0000-4000-8000-000000000022',
    projectId: secondProjectId,
    projectName: 'second-fixture',
    taskId: secondTaskId,
  })
  second.stage.stepTexts![0] = { ...second.stage.stepTexts![0]!, id: secondTextId }
  second.stage.obligations![0] = { ...second.stage.obligations![0]!, id: secondObligationId }
  const memory = createMemoryRecordApiClient({
    taskFlowStages: [hostedStage(), second],
    taskFlowProjectSpaces: { [PROJECT_ID]: firstSpace, [secondProjectId]: secondSpace },
  })
  let whoamiCalls = 0
  const client = {
    ...memory,
    whoami: async () => {
      whoamiCalls++
      return memory.whoami()
    },
  }
  const store = recordTaskFlowReadStore(d, client)
  expect(await store.openStageWorktrees()).toEqual([
    { number: 1, workflow: 'flow', project: 'fixture', args: '{}' },
    { number: 1, workflow: 'flow', project: 'second-fixture', args: '{}' },
  ])
  expect((await store.stageByRecordId(second.stage.id))?.record_id).toBe(second.stage.id)
  expect((await store.openStageForTask(secondTaskId))?.record_id).toBe(second.stage.id)
  expect((await store.textByRecordId(secondTextId))?.body).toBe('fixture text')
  expect((await store.obligationByRecordId(secondObligationId))?.id).toBe(secondObligationId)
  expect(whoamiCalls).toBe(1)
})

test('record adapter resolves a stage that reached the record through the sync path', async () => {
  const d = database()
  ensureMachineIdentity(d)
  const access = {
    memberships: [{ spaceId: 'space-id', slug: 'fixture', permission: 'write' as const }],
    personalSpaceId: null,
    client: { readTaskFlowPresence: async () => ({ flowIds: [], stageIds: [] }) },
  }
  expect(await backfillTaskFlowRecords(d, access)).toMatchObject({ enqueuedStages: 1 })
  const synced = (kind: string) =>
    d
      .query<{ payload: string }, [string]>('SELECT payload FROM outbox WHERE kind=? ORDER BY id')
      .all(kind)
      .map((row) => JSON.parse(row.payload) as RecordPayload)
  const rows = { flows: synced('task_flow'), stages: synced('task_flow_stage') }
  const stageId = String(rows.stages[0]!.id)
  const hosted = recordTaskFlowReadStore(
    d,
    createMemoryRecordApiClient({ taskFlowSyncedRows: rows }),
  )

  expect((await hosted.stageByHandle('fixture', 1))?.record_id).toBe(stageId)
  expect((await hosted.openStageForTask(TASK_ID))?.record_id).toBe(stageId)
})
