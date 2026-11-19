import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { guardHostedTables } from '../database/hosted-table-guard.ts'
import { recordApiError } from '../record/record-api-client-error.ts'
import { recordKeyedNotVisibleRefusal } from '../record/record-keyed-read.ts'
import {
  database,
  FLOW_ID,
  hostedStage,
  MACHINE_ID,
  OBLIGATION_ID,
  PROJECT_ID,
  TASK_ID,
  TEXT_ID,
} from './task-flow-store-record.fixture.ts'
import { recordTaskFlowReadStore } from './task-flow-store-record.ts'
import { sqliteTaskFlowReadStore } from './task-flow-store-sqlite.ts'

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

test('removing copied text leaves its reference readable in both stores', async () => {
  const d = database()
  d.query('DELETE FROM workflow_step_text WHERE record_id=?').run(TEXT_ID)
  const local = sqliteTaskFlowReadStore(d)
  const stage = hostedStage()
  stage.stage.stepTexts = []
  const hosted = recordTaskFlowReadStore(
    d,
    createMemoryRecordApiClient({ taskFlowStages: [stage] }),
  )

  expect(await local.liveTextAttachment(TEXT_ID)).toBeNull()
  expect(await hosted.liveTextAttachment(TEXT_ID)).toBeNull()
  expect(await hosted.copiedTextReference(TEXT_ID)).toBe(await local.copiedTextReference(TEXT_ID))
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
  const q4 = '00000000-0000-4000-8000-000000000034'
  const q5 = '00000000-0000-4000-8000-000000000035'
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
  d.query(
    `INSERT INTO question
     (record_id,number,workflow_cursor_record_id,workflow_key,asked_at,question)
     VALUES ('00000000-0000-4000-8000-000000000036',6,?,NULL,
             '2026-11-12T00:00:30.000Z','other open?'),
            ('00000000-0000-4000-8000-000000000037',7,?,NULL,
             '2026-11-12T00:00:31.000Z','another open?')`,
  ).run(stageThreeId, stageThreeId)

  const rootRun = '00000000-0000-4000-8000-000000000041'
  const childRun = '00000000-0000-4000-8000-000000000042'
  d.query(
    `INSERT INTO run
     (record_id,number,started_at,agent,job,repo,cwd,project_record_id,task_record_id,
      prompt_sha,prompt_bytes,prompt_head,status,latency_ms,probe,turn,transport,session_id)
     VALUES (?,41,'2026-11-12T00:00:00.000Z','codex','implement','root-repo','/root-cwd',?,?,
             'sha',1,'root','ok',1,0,1,'cli','root-session')`,
  ).run(rootRun, PROJECT_ID, TASK_ID)
  d.query(
    `INSERT INTO run
     (record_id,number,started_at,agent,job,repo,cwd,project_record_id,
      prompt_sha,prompt_bytes,prompt_head,status,latency_ms,probe,turn,transport,session_id,parent_run_record_id)
     VALUES (?,42,'2026-11-12T00:01:00.000Z','codex','implement','child-repo','/child-cwd',?,
             'sha',1,'child','ok',1,0,2,'cli','child-session',?)`,
  ).run(childRun, PROJECT_ID, rootRun)
  d.query(
    `INSERT INTO question
     (record_id,number,run_record_id,asked_at,question,answer,answered_at)
     VALUES (?,4,?,'2026-11-12T00:04:00.000Z','run child?','yes',
             '2026-11-12T00:05:00.000Z'),
            (?,5,?,'2026-11-12T00:05:00.000Z','run only?','yes',
             '2026-11-12T00:06:00.000Z')`,
  ).run(q4, childRun, q5, childRun)
  d.query(
    `INSERT INTO outbox (record_id,kind,row_id,payload,created_at,synced_at)
     VALUES ('00000000-0000-4000-8000-000000000043','run',?,'{}','t','t')`,
  ).run(childRun)

  const first = hostedStage()
  first.stage.workflow = 'ship-task'
  first.stage.state = 'awaiting-ruling'
  first.stage.arguments = { branch: 'feature' }
  first.stage.updatedAt = '2026-11-12T00:03:00.000Z'
  const second = hostedStage({ taskless: true, number: 2, stageId: stageTwoId })
  second.stage.instanceId = '#2'
  second.stage.state = 'awaiting-ruling'
  second.stage.updatedAt = '2026-11-12T00:02:00.000Z'
  const third = hostedStage({ taskless: true, number: 3, stageId: stageThreeId })
  third.stage.instanceId = '#3'
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
    [hosted.workflowInboxQuestions(), local.workflowInboxQuestions()],
    [
      hosted.rulingRows({ kind: 'all', after: null, cursor: null }),
      local.rulingRows({ kind: 'all', after: null, cursor: null }),
    ],
    [hosted.rulingFileQuestion(q4), local.rulingFileQuestion(q4)],
    [hosted.questionCloseFacts(q1), local.questionCloseFacts(q1)],
    [hosted.overturnRulingRow(q3), local.overturnRulingRow(q3)],
    [hosted.taskRulingRows('fixture', TASK_ID, 1), local.taskRulingRows('fixture', TASK_ID, 1)],
    [hosted.localQuestionProjects(), local.localQuestionProjects()],
  ]
  for (const [recordAnswer, localAnswer] of assertions)
    expect(await recordAnswer).toEqual(await localAnswer)
  expect(
    (await hosted.listOpenStages({})).find((row) => row.record_id === stageThreeId),
  ).toMatchObject({ question_number: 6 })
  expect(await hosted.rulingFileQuestion(q4)).toMatchObject({
    root_id: rootRun,
    repo: 'child-repo',
    cwd: '/child-cwd',
  })
  expect(
    (await hosted.rulingRows({ kind: 'all', after: null, cursor: null })).find(
      (row) => row.record_id === q4,
    ),
  ).toMatchObject({ project: 'child-repo', session_id: 'child-session' })
  expect(await hosted.taskRulingRows('fixture', TASK_ID, 1)).toMatchObject([{ candidate_count: 3 }])
})

test('question joins refuse a stage missing from the hosted record', async () => {
  const d = database()
  const missingStage = '00000000-0000-4000-8000-000000000099'
  const questionId = '00000000-0000-4000-8000-000000000098'
  d.exec('PRAGMA foreign_keys=OFF')
  try {
    d.query(
      `INSERT INTO question
       (record_id,number,workflow_cursor_record_id,workflow_key,asked_at,question)
       VALUES (?,98,?,'DEV-2234','t','missing?')`,
    ).run(questionId, missingStage)
  } finally {
    d.exec('PRAGMA foreign_keys=ON')
  }
  const hosted = recordTaskFlowReadStore(d, createMemoryRecordApiClient({ taskFlowStages: [] }))
  const refusal =
    `question 98 names workflow stage ${missingStage}, which the hosted record does not return; ` +
    `run ${PLATFORM_NAME} record push, then retry`
  await expect(hosted.questionCloseFacts(questionId)).rejects.toThrow(refusal)
  await expect(hosted.rulingRows({ kind: 'workflow', after: null, cursor: null })).rejects.toThrow(
    refusal,
  )
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
  d.query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)').run(
    '00000000-0000-4000-8000-000000000026',
    'local-only',
    '/local-only',
    'bun',
    '{}',
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
    {
      record_id: hostedStage().stage.id,
      number: 1,
      workflow: 'flow',
      project: 'fixture',
      args: '{}',
      closed: '[]',
      revision: 1,
    },
    {
      record_id: second.stage.id,
      number: 1,
      workflow: 'flow',
      project: 'second-fixture',
      args: '{}',
      closed: '[]',
      revision: 1,
    },
  ])
  expect((await store.stageByRecordId(second.stage.id))?.record_id).toBe(second.stage.id)
  expect((await store.openStageForTask(secondTaskId))?.record_id).toBe(second.stage.id)
  expect((await store.textByRecordId(secondTextId))?.body).toBe('fixture text')
  expect((await store.obligationByRecordId(secondObligationId))?.id).toBe(secondObligationId)
  expect(whoamiCalls).toBe(1)
})

test('machine-wide hosted reads return no rows when every project lacks a space', async () => {
  const d = database()
  d.query('UPDATE project SET settings = ?').run('{}')
  const store = recordTaskFlowReadStore(
    d,
    createMemoryRecordApiClient({ taskFlowStages: [hostedStage()] }),
  )

  expect(await store.listOpenStages({})).toEqual([])
})

test('machine-wide hosted reads skip a project whose space is whitespace only', async () => {
  const d = database()
  d.query('UPDATE project SET settings = ?').run(JSON.stringify({ space: '   ' }))
  const store = recordTaskFlowReadStore(
    d,
    createMemoryRecordApiClient({ taskFlowStages: [hostedStage()] }),
  )

  expect(await store.listOpenStages({})).toEqual([])
})

test('a hosted read aimed at a project without a space keeps the destination refusal', async () => {
  const d = database()
  d.query('UPDATE project SET settings = ?').run('{}')
  const store = recordTaskFlowReadStore(d, createMemoryRecordApiClient({ taskFlowStages: [] }))

  await expect(store.listOpenStages({ project: 'fixture' })).rejects.toThrow(
    'project fixture has no declared record space',
  )
})

test('each hosted task-flow keyed read uses one destination-free request', async () => {
  const d = database()
  const stage = hostedStage()
  const counts = {
    flowsById: 0,
    stageLists: 0,
    stagesById: 0,
    textsById: 0,
    obligationsById: 0,
  }
  const memory = createMemoryRecordApiClient({
    taskFlowStages: [stage],
    taskFlowProjectSpaces: { [PROJECT_ID]: '01990000-0000-7000-8000-000000000002' },
    taskFlowReadCounts: counts,
  })
  const destinations: unknown[] = []
  const client = {
    ...memory,
    readTaskFlow: async (
      selector: Parameters<NonNullable<typeof memory.readTaskFlow>>[0],
      destination: Parameters<NonNullable<typeof memory.readTaskFlow>>[1],
    ) => {
      destinations.push(destination)
      return memory.readTaskFlow!(selector, destination)
    },
    readTaskFlowStage: async (
      id: string,
      destination: Parameters<NonNullable<typeof memory.readTaskFlowStage>>[1],
    ) => {
      destinations.push(destination)
      return memory.readTaskFlowStage!(id, destination)
    },
    readTaskFlowText: async (
      id: string,
      destination: Parameters<NonNullable<typeof memory.readTaskFlowText>>[1],
    ) => {
      destinations.push(destination)
      return memory.readTaskFlowText!(id, destination)
    },
    readTaskFlowObligation: async (
      id: string,
      destination: Parameters<NonNullable<typeof memory.readTaskFlowObligation>>[1],
    ) => {
      destinations.push(destination)
      return memory.readTaskFlowObligation!(id, destination)
    },
  }
  const store = recordTaskFlowReadStore(d, client)
  await store.flowState(stage.flow.id)
  expect(counts.flowsById).toBe(1)
  await store.stageByRecordId(stage.stage.id)
  expect(counts.stagesById).toBe(1)
  await store.textByRecordId(stage.stage.stepTexts![0]!.id)
  expect(counts.textsById).toBe(1)
  await store.obligationByRecordId(stage.stage.obligations![0]!.id)
  expect(counts.obligationsById).toBe(1)
  expect(counts.stagesById).toBe(2)
  expect(destinations).toEqual([undefined, undefined, undefined, undefined, undefined])
})

test('a missing hosted task flow reads as null only for an absent-row refusal', async () => {
  const d = database()
  const storeFor = (body: unknown) =>
    recordTaskFlowReadStore(d, {
      readTaskFlow: async () => {
        throw recordApiError(body, 404)
      },
    })

  await expect(storeFor(recordKeyedNotVisibleRefusal(5)).flowState(FLOW_ID)).resolves.toBeNull()
  await expect(
    storeFor({ error: 'route not found', code: 'route_not_found' }).flowState(FLOW_ID),
  ).rejects.toThrow('route not found')
})

describe('hosted task-flow question decorations', () => {
  let previousRecordApiUrl: string | undefined

  beforeEach(() => {
    previousRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
    process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  })

  afterEach(() => {
    installRecordApiClient(null)
    if (previousRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = previousRecordApiUrl
  })

  test('question-decorated reads never access the local question table', async () => {
    const d = guardHostedTables(database(), ['question'])
    const stage = hostedStage()
    stage.stage.workflowKey = null
    const client = createMemoryRecordApiClient({
      taskFlowStages: [stage],
      questions: [
        {
          id: '00000000-0000-4000-8000-000000000090',
          number: 90,
          workflowCursorRecordId: stage.stage.id,
          workflowTaskId: TASK_ID,
          askedAt: '2026-11-12T00:04:00.000Z',
          question: 'Hosted?',
          answer: 'yes',
          answeredAt: '2026-11-12T00:05:00.000Z',
          closedAt: null,
        },
      ],
    })
    installRecordApiClient(client)
    const hosted = recordTaskFlowReadStore(d, client)
    await hosted.listOpenStages({})
    await hosted.keylessSessionCursors(null)
    await hosted.rulingRows({ kind: 'all', after: null, cursor: null })
    await hosted.taskRulingRows('fixture', TASK_ID, 10)
  })

  test('open details for several stages use one batched keyed question request', async () => {
    const d = guardHostedTables(database(), ['question'])
    const first = hostedStage({ taskless: true })
    first.stage.workflowKey = null
    const second = hostedStage({
      taskless: true,
      number: 2,
      stageId: '00000000-0000-4000-8000-000000000098',
      flowId: '00000000-0000-4000-8000-000000000099',
    })
    second.stage.workflowKey = null
    const memory = createMemoryRecordApiClient({
      taskFlowStages: [first, second],
      questions: [
        {
          id: '00000000-0000-4000-8000-000000000096',
          number: 96,
          workflowCursorRecordId: first.stage.id,
        },
        {
          id: '00000000-0000-4000-8000-000000000097',
          number: 97,
          workflowCursorRecordId: second.stage.id,
        },
      ],
    })
    let requests = 0
    const client = {
      ...memory,
      readQuestions: async (...args: Parameters<NonNullable<typeof memory.readQuestions>>) => {
        requests++
        expect(args[0]).toMatchObject({
          read: 'open-for-cursors',
          workflowCursorRecordIds: [first.stage.id, second.stage.id],
        })
        return memory.readQuestions!(...args)
      },
    }
    installRecordApiClient(client)
    const rows = await recordTaskFlowReadStore(d, client).keylessSessionCursors(null)
    expect(rows.map((row) => row.open_question_record_id)).toEqual([
      '00000000-0000-4000-8000-000000000096',
      '00000000-0000-4000-8000-000000000097',
    ])
    expect(requests).toBe(1)
  })

  test('open details for 101 stages use two capped keyed question requests', async () => {
    const d = guardHostedTables(database(), ['question'])
    const stages = Array.from({ length: 101 }, (_, index) => {
      const suffix = (index + 200).toString(16).padStart(12, '0')
      const stage = hostedStage({
        taskless: true,
        number: index + 1,
        stageId: `00000000-0000-4000-8000-${suffix}`,
        flowId: `00000000-0000-4001-8000-${suffix}`,
      })
      stage.stage.workflowKey = null
      return stage
    })
    const questions = [stages[0]!, stages[100]!].map((stage, index) => ({
      id: `00000000-0000-4002-8000-${(index + 1).toString(16).padStart(12, '0')}`,
      number: index + 1,
      workflowCursorRecordId: stage.stage.id,
    }))
    const memory = createMemoryRecordApiClient({ taskFlowStages: stages, questions })
    const chunkSizes: number[] = []
    const client = {
      ...memory,
      readQuestions: async (...args: Parameters<NonNullable<typeof memory.readQuestions>>) => {
        if (args[0].read === 'open-for-cursors')
          chunkSizes.push(args[0].workflowCursorRecordIds.length)
        return memory.readQuestions!(...args)
      },
    }
    installRecordApiClient(client)
    const rows = await recordTaskFlowReadStore(d, client).keylessSessionCursors(null)
    expect(chunkSizes).toEqual([100, 1])
    expect(rows.filter((row) => row.open_question_record_id !== null)).toEqual([
      expect.objectContaining({
        record_id: stages[0]!.stage.id,
        open_question_record_id: questions[0]!.id,
      }),
      expect.objectContaining({
        record_id: stages[100]!.stage.id,
        open_question_record_id: questions[1]!.id,
      }),
    ])
  })
})
