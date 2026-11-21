import { afterEach, expect, test } from 'bun:test'
import { resolvedRecordOrigin } from '../../../shared/record-api-url.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { installTaskRows } from '../../test/fixtures/task-reader.ts'
import { boardClaimTake } from '../board/board-operations.ts'
import { guardHostedTables } from '../database/hosted-table-guard.ts'
import { contextBrief } from '../doc/context-brief.ts'
import { projectByName, upsertProject } from '../project/projects.ts'
import { rememberActiveRecordSpace } from '../project-space.ts'
import { rememberProjectSpace } from '../project-space-cache.ts'
import type { HostedTaskFlowStageById } from '../record/record-task-flow-contract.ts'
import { TASK_FLOW_STAGE_STATES } from '../record/record-task-flow-contract.ts'
import { reviewContext } from '../session/context-review.ts'
import { sessionStopSummary } from '../session/stop-summary.ts'
import { taskFlowReadStore } from './task-flow-store.ts'
import {
  abandonSelectedWorkflowCursorForClose,
  awaitWorkflowRuling,
  composeWorkflowWithCursor,
} from './workflow-cursor.ts'
import { workflowCursorListCommand } from './workflow-cursor-format.ts'
import { listWorkflowCursors } from './workflow-cursor-list.ts'
import { ruleWorkflow } from './workflow-cursor-ruling.ts'
import { getWorkflowStepWithCursor } from './workflow-cursor-serve.ts'
import {
  database as cursorDatabase,
  selectAndNextWorkflowStep,
  testPorts,
} from './workflow-cursor-test.fixture.ts'
import { linkWorkflowTaskLabel } from './workflow-task-linking.ts'
import { attachWorkflowTextByHandle, deleteWorkflowText } from './workflow-text.ts'
import { copyWorkflowTextForCursor } from './workflow-text-copy.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

const taskFlowTables = [
  'workflow_cursor',
  'task_flow',
  'workflow_obligation',
  'workflow_step_text',
  'workflow_text_copy',
] as const

const destinationSpaceId = 'fixture-space'
const workflow = 'hosted-task-flow-guard'
const taskKey = 'DEV-HOSTED-GUARD'
const taskId = '00000000-0000-4000-8001-000000000001'
const secondProjectId = '00000000-0000-4000-8001-000000000002'
const WORKFLOW_CURSOR_TASK_FLOW_CALL_LIMIT = 2
const STOP_SUMMARY_TASK_FLOW_CALL_LIMIT = 3
const CONTEXT_BRIEF_TASK_FLOW_CALL_LIMIT = 3
const CONTEXT_REVIEW_TASK_FLOW_CALL_LIMIT = 5
const STOP_CHILD_FACT_STAGE_LIST_BYTE_BUDGET = 22_127

type TaskFlowReadCounts = NonNullable<
  NonNullable<Parameters<typeof createMemoryRecordApiClient>[0]>['taskFlowReadCounts']
>

function taskFlowReadDelta(before: TaskFlowReadCounts, after: TaskFlowReadCounts) {
  const byKind = {
    flowsById: after.flowsById - before.flowsById,
    stageLists: after.stageLists - before.stageLists,
    stagesById: after.stagesById - before.stagesById,
    textsById: after.textsById - before.textsById,
    obligationsById: after.obligationsById - before.obligationsById,
    stageSummaries: (after.stageSummaries ?? 0) - (before.stageSummaries ?? 0),
  }
  return { byKind, total: Object.values(byKind).reduce((sum, count) => sum + count, 0) }
}

afterEach(() => {
  installRecordApiClient(null)
  installTaskRows(null)
})

test('hosted task-flow intents never touch the five local task-flow tables', async () => {
  const raw = cursorDatabase()
  const draft = setWorkflowLocal(
    workflow,
    {
      title: 'Hosted task-flow guard fixture',
      description: 'Drives each hosted task-flow intent through its public workflow entry point.',
      arguments: [{ name: 'key', required: false, description: 'Task key.' }],
      modes: [
        {
          slug: 'default',
          title: 'Default',
          default: true,
          steps: ['score', 'complete', 'ship-triage'],
        },
      ],
    },
    'hosted task-flow guard fixture',
    'test',
    raw,
  )
  promoteWorkflowLocal(workflow, draft.n, 'publish hosted task-flow guard fixture', 'test', raw)
  raw.query('UPDATE workflow SET space_id = ? WHERE slug = ?').run(destinationSpaceId, workflow)
  raw
    .query(
      'UPDATE workflow_version SET space_id = ? WHERE workflow_record_id = (SELECT record_id FROM workflow WHERE slug = ? AND space_id = ?)',
    )
    .run(destinationSpaceId, workflow, destinationSpaceId)
  raw.query('UPDATE step_catalogue SET space_id = ?').run(destinationSpaceId)
  raw.query('UPDATE step_catalogue_version SET space_id = ?').run(destinationSpaceId)
  rememberActiveRecordSpace(raw, destinationSpaceId)
  rememberProjectSpace(raw, 'fixture', destinationSpaceId)
  const registeredProject = projectByName('fixture', raw)!
  upsertProject({
    recordId: registeredProject.recordId,
    name: registeredProject.name,
    path: registeredProject.path,
    stack: registeredProject.stack,
    canon: registeredProject.canon,
    settings: { ...registeredProject.settings, space: destinationSpaceId },
  })
  raw
    .query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)')
    .run(secondProjectId, 'second-fixture', '/second-fixture', 'bun', '{}')
  raw
    .query('INSERT INTO record_install_binding (id,bound_at,record_origin) VALUES (1,?,?)')
    .run('2026-11-15T00:00:00.000Z', resolvedRecordOrigin())

  const database = guardHostedTables(raw, taskFlowTables)
  const taskFlowStages: HostedTaskFlowStageById[] = []
  const memoryInput = {
    taskFlowComposeEnforcement: 'note-only',
    taskFlowStages,
    taskFlowProjectSpaces: {
      [raw
        .query<{ record_id: string }, []>("SELECT record_id FROM project WHERE name='fixture'")
        .get()!.record_id]: destinationSpaceId,
      [secondProjectId]: destinationSpaceId,
    },
    taskFlowReadCounts: {
      flowsById: 0,
      stageLists: 0,
      stagesById: 0,
      textsById: 0,
      obligationsById: 0,
      stageSummaries: 0,
    },
  }
  const memory = createMemoryRecordApiClient(memoryInput)
  const taskFlowClient = {
    ...memory,
    whoami: async () => ({
      user: { id: 'fixture-user' },
      activeSpaceId: destinationSpaceId,
      personalSpaceId: destinationSpaceId,
      memberships: [
        { space_id: destinationSpaceId, slug: 'fixture-space', permission: 'write' as const },
      ],
    }),
  }
  installRecordApiClient(taskFlowClient)
  const stopTasks = [
    {
      key: taskKey,
      record_id: taskId,
      project: 'fixture',
      title: 'Hosted task-flow guard task',
      parent_key: null,
      status: 'open',
      status_category: 'open',
      last_seen: null,
      opened_at: null,
      has_children: false,
    },
  ]
  installTaskRows(stopTasks)
  const context = { session: 'hosted-task-flow-guard', taskFlowClient }

  const composed = await composeWorkflowWithCursor(
    workflow,
    'fixture',
    'default',
    {},
    context,
    database,
    {},
    {},
  )
  const cursor = composed.cursor!.id
  expect(
    await getWorkflowStepWithCursor(
      workflow,
      'fixture',
      'score',
      {},
      'default',
      context,
      database,
      {},
      cursor,
    ),
  ).toMatchObject({ slug: 'score', cursor })

  await selectAndNextWorkflowStep(
    workflow,
    'fixture',
    'default',
    {},
    'advance the hosted flow',
    context,
    database,
    {},
    testPorts,
    cursor,
  )
  await awaitWorkflowRuling(
    workflow,
    'fixture',
    'default',
    {},
    'May the hosted flow continue?',
    context,
    database,
    () => {},
    cursor,
  )
  await ruleWorkflow(
    workflow,
    'fixture',
    'default',
    {},
    'Continue.',
    true,
    'mcp',
    context,
    database,
    cursor,
  )
  await selectAndNextWorkflowStep(
    workflow,
    'fixture',
    'default',
    {},
    'adopt the task key',
    context,
    database,
    { task: taskKey },
    testPorts,
    cursor,
  )

  const hosted = (await taskFlowClient.listTaskFlowStages!({ workflow }, { destinationSpaceId }))
    .items[0]!
  const hostedStage = hosted.stage as typeof hosted.stage & { closedStepNotes: unknown[] }
  const attachment = await attachWorkflowTextByHandle(
    cursor,
    'Hosted attachment.',
    context,
    database,
  )
  const copied = await copyWorkflowTextForCursor(
    {
      recordId: hostedStage.id,
      number: cursor,
      project: 'fixture',
      taskKey,
      taskRecordId: taskId,
      state: hostedStage.state,
    },
    database,
    async () => ({ key: taskKey, record_id: taskId, project: 'fixture', source: 'local' }),
    {
      list: async () => [],
      create: async () => 'DEV-HOSTED-GUARD/1',
    },
    taskFlowClient,
  )
  expect(copied.copied).toHaveLength(1)
  await deleteWorkflowText(hostedStage.id, true, database, taskFlowClient)
  expect(
    await linkWorkflowTaskLabel(
      database,
      { project: 'fixture', workflowKey: taskKey, taskRecordId: taskId },
      taskFlowClient,
    ),
  ).toEqual({ workflow_cursor: 1, question: 1 })
  expect(raw.query('SELECT count(*) count FROM question').get()).toEqual({ count: 0 })
  expect(attachment).toStartWith('attached-text:')

  const readStore = taskFlowReadStore(database, taskFlowClient)
  const workflowKeyBatchSizes: number[] = []
  const batchingStore = taskFlowReadStore(database, {
    ...taskFlowClient,
    listTaskFlowStages: async (selector, destination) => {
      workflowKeyBatchSizes.push(selector.workflowKeys?.length ?? 0)
      return taskFlowClient.listTaskFlowStages!(selector, destination)
    },
  })
  await batchingStore.listStages({
    project: 'fixture',
    workflowKeys: Array.from({ length: 101 }, (_, index) => `DEV-BATCH-${index}`),
    states: TASK_FLOW_STAGE_STATES,
  })
  expect(workflowKeyBatchSizes).toEqual([100, 1])
  workflowKeyBatchSizes.length = 0
  expect(
    await batchingStore.listStages({
      project: 'fixture',
      workflowKeys: [],
      states: TASK_FLOW_STAGE_STATES,
    }),
  ).toEqual([])
  expect(workflowKeyBatchSizes).toEqual([])
  const selected = (await readStore.listOpenStages({ project: 'fixture' }))[0]!
  await abandonSelectedWorkflowCursorForClose(
    selected,
    'prove the guarded hosted all-state read',
    { ...context, taskRecordId: taskId },
    database,
    { key: taskKey },
  )
  expect(
    await readStore.listStages({ project: 'fixture', states: TASK_FLOW_STAGE_STATES }),
  ).toMatchObject([{ state: 'abandoned', question_number: null }])
  expect(await readStore.listOpenStages({ project: 'fixture' })).toEqual([])
  memoryInput.taskFlowStages.push({
    flow: {
      ...hosted.flow,
      id: '00000000-0000-4000-8001-000000000003',
      projectId: secondProjectId,
    },
    stage: {
      ...hostedStage,
      id: '00000000-0000-4000-8001-000000000004',
      flowRecordId: '00000000-0000-4000-8001-000000000003',
      projectId: secondProjectId,
      projectName: 'second-fixture',
    },
  })
  const handoffStageId = memoryInput.taskFlowStages.at(-1)!.stage.id
  const openObligation = {
    id: '00000000-0000-4000-8003-000000000001',
    stageRecordId: hostedStage.id,
    stepOrdinal: 0,
    stepSlug: 'score',
    floor: 'command-exit',
    requirePullRequest: false,
    expectedExitCode: 0,
    expectedStatus: 'passed',
    floorDeferrable: false,
    reason: 'guard the open-obligation batch read',
    sessionId: context.session,
    createdAt: hostedStage.createdAt,
    satisfiedAt: null,
    satisfiedStepOrdinal: null,
    satisfiedStepSlug: null,
    satisfiedEvidence: null,
    abandonedAt: null,
    abandonedReason: null,
    operatorRuling: false,
  }
  Object.assign(hostedStage, {
    state: 'running',
    handedOffFromRecordId: handoffStageId,
    obligations: [openObligation],
  })

  const measure = async (entry: () => Promise<unknown>) => {
    const before = { ...memoryInput.taskFlowReadCounts }
    await entry()
    return taskFlowReadDelta(before, memoryInput.taskFlowReadCounts)
  }
  const measureEntryPoints = async () => {
    const cwd = process.cwd()
    process.chdir('/tmp')
    try {
      const cursorRows: Awaited<ReturnType<typeof listWorkflowCursors>> = []
      const cursor = await measure(async () => {
        cursorRows.push(...(await listWorkflowCursors({ session: context.session }, database)))
      })
      expect(cursorRows).not.toHaveLength(0)
      expect(
        cursorRows.every((row) =>
          (row as typeof row & { obligations: string }).obligations.includes(
            '(score:command-exit)',
          ),
        ),
      ).toBe(true)
      const stop = await measure(() =>
        sessionStopSummary(
          {
            session: context.session,
            previousBlockKey: null,
            now: '2026-11-21T12:00:00.000Z',
          },
          database,
        ),
      )
      const brief = await measure(() => contextBrief(context.session, '/tmp', database))
      const review = await measure(() =>
        reviewContext(context.session, {
          database,
          now: () => Date.parse('2026-11-21T12:00:00.000Z'),
        }),
      )
      const entries = {
        cursor: { result: cursor, limit: WORKFLOW_CURSOR_TASK_FLOW_CALL_LIMIT },
        stop: { result: stop, limit: STOP_SUMMARY_TASK_FLOW_CALL_LIMIT },
        brief: { result: brief, limit: CONTEXT_BRIEF_TASK_FLOW_CALL_LIMIT },
        review: { result: review, limit: CONTEXT_REVIEW_TASK_FLOW_CALL_LIMIT },
      }
      for (const [name, { result, limit }] of Object.entries(entries)) {
        expect(
          result.total,
          `${name} task-flow reads ${JSON.stringify(result.byKind)}`,
        ).toBeLessThanOrEqual(limit)
        expect(result.byKind.stagesById, `${name} stage-by-id reads`).toBe(0)
      }
      return Object.fromEntries(
        Object.entries(entries).map(([name, entry]) => [name, entry.result]),
      ) as Record<keyof typeof entries, ReturnType<typeof taskFlowReadDelta>>
    } finally {
      process.chdir(cwd)
    }
  }

  const one = await measureEntryPoints()

  for (let index = 2; index <= 10; index++) {
    const stageId = `00000000-0000-4000-8002-${String(index).padStart(12, '0')}`
    memoryInput.taskFlowStages.push({
      flow: { ...hosted.flow },
      stage: {
        ...hostedStage,
        id: stageId,
        number: index,
        state: index % 2 === 0 ? 'awaiting-ruling' : 'running',
        handedOffFromRecordId: handoffStageId,
        obligations: [
          {
            ...openObligation,
            id: `00000000-0000-4000-8003-${String(index).padStart(12, '0')}`,
            stageRecordId: stageId,
          },
        ],
        stepTexts: [],
        textCopies: [],
      },
    })
  }
  const ten = await measureEntryPoints()
  expect(
    Object.fromEntries(
      Object.keys(one).map((name) => [
        name,
        [one[name as keyof typeof one].total, ten[name as keyof typeof ten].total],
      ]),
    ),
  ).toEqual({ cursor: [2, 2], stop: [3, 3], brief: [3, 3], review: [5, 5] })

  memoryInput.taskFlowStages.push({
    flow: {
      ...hosted.flow,
      id: '00000000-0000-4000-8001-000000000006',
      openStageRecordId: '00000000-0000-4000-8001-000000000007',
    },
    stage: {
      ...hostedStage,
      id: '00000000-0000-4000-8001-000000000007',
      flowRecordId: '00000000-0000-4000-8001-000000000006',
      number: 11,
      workflow: 'plan-task',
      activeSlug: 'start',
      workflowKey: taskKey,
      sessionId: context.session,
      state: 'running',
      obligations: [],
      stepTexts: [],
      textCopies: [],
    },
  })
  installTaskRows([
    {
      key: taskKey,
      record_id: taskId,
      project: 'fixture',
      title: 'Hosted task-flow guard epic',
      parent_key: null,
      status: 'open',
      status_category: 'open',
      last_seen: null,
      opened_at: null,
      has_children: true,
    },
    {
      key: 'DEV-HOSTED-GUARD-CHILD',
      record_id: '00000000-0000-4000-8001-000000000005',
      project: 'fixture',
      title: 'Hosted task-flow guard child',
      parent_key: taskKey,
      status: 'open',
      status_category: 'open',
      last_seen: null,
      opened_at: null,
      has_children: false,
    },
  ])
  await boardClaimTake(
    { project: 'fixture', subject: `task:${taskKey}` },
    {
      database: raw,
      cwd: '/fixture',
      taskCursorAuthority: { mode: 'take', session: context.session },
    },
  )
  const childFactStageRows: number[] = []
  const childFactStageBytes: number[] = []
  const childFactStageViews: Array<string | undefined> = []
  let measureChildFactStages = false
  const countedTaskFlowClient = {
    ...taskFlowClient,
    listTaskFlowStages: async (
      selector: Parameters<NonNullable<typeof taskFlowClient.listTaskFlowStages>>[0],
      destination: Parameters<NonNullable<typeof taskFlowClient.listTaskFlowStages>>[1],
    ) => {
      const result = await taskFlowClient.listTaskFlowStages!(selector, destination)
      if (
        measureChildFactStages &&
        selector.projectId &&
        !selector.sessionId &&
        selector.states?.length === TASK_FLOW_STAGE_STATES.length
      ) {
        childFactStageRows.push(result.items.length)
        childFactStageBytes.push(new TextEncoder().encode(JSON.stringify(result)).byteLength)
        childFactStageViews.push(selector.view)
      }
      return result
    },
  }
  installRecordApiClient(countedTaskFlowClient)
  expect(
    (await taskFlowReadStore(database).listOpenStages({ project: 'fixture' })).some(
      (stage) => stage.workflow_slug === 'plan-task' && stage.step_slug === 'start',
    ),
  ).toBe(true)
  expect(
    (await listWorkflowCursors({ session: context.session }, database)).some(
      (stage) => stage.workflow_slug === 'plan-task' && stage.step_slug === 'start',
    ),
  ).toBe(true)
  const stopWithHistory = async () => {
    const before = { ...memoryInput.taskFlowReadCounts }
    const rowOffset = childFactStageRows.length
    const byteOffset = childFactStageBytes.length
    measureChildFactStages = true
    const summary = await sessionStopSummary(
      {
        session: context.session,
        previousBlockKey: null,
        now: '2026-11-21T12:00:00.000Z',
      },
      database,
    ).finally(() => {
      measureChildFactStages = false
    })
    const reads = taskFlowReadDelta(before, memoryInput.taskFlowReadCounts)
    const stageRows = childFactStageRows.slice(rowOffset).reduce((total, rows) => total + rows, 0)
    const stageBytes = childFactStageBytes
      .slice(byteOffset)
      .reduce((total, bytes) => total + bytes, 0)
    return { reads, stageBytes, stageRows, summary }
  }
  const withoutHistory = await stopWithHistory()
  for (let index = 0; index < 1_500; index++) {
    const suffix = String(index + 100).padStart(12, '0')
    memoryInput.taskFlowStages.push({
      flow: {
        ...hosted.flow,
        id: `00000000-0000-4000-8010-${suffix}`,
        taskId: null,
        taskKey: `DEV-HISTORY-${index}`,
      },
      stage: {
        ...hostedStage,
        id: `00000000-0000-4000-8020-${suffix}`,
        flowRecordId: `00000000-0000-4000-8010-${suffix}`,
        number: index + 100,
        workflowKey: `DEV-HISTORY-${index}`,
        sessionId: 'unrelated-history',
        state: index % 2 === 0 ? 'done' : 'abandoned',
        obligations: [],
        stepTexts: [],
        textCopies: [],
      },
    })
  }
  const withHistory = await stopWithHistory()
  expect(withHistory.stageBytes).toBe(withoutHistory.stageBytes)
  expect(childFactStageViews).toEqual(['summary', 'summary'])
  expect(
    [withoutHistory.stageBytes, withHistory.stageBytes].every(
      (bytes) => bytes < STOP_CHILD_FACT_STAGE_LIST_BYTE_BUDGET,
    ),
  ).toBe(true)
  expect([withoutHistory.reads.total, withHistory.reads.total]).toEqual([4, 4])
  expect([withoutHistory.stageRows, withHistory.stageRows]).toEqual([11, 11])
  expect(withHistory.summary).toEqual(withoutHistory.summary)

  const readStageSummaries = taskFlowClient.readTaskFlowStageSummaries!
  installRecordApiClient({
    ...taskFlowClient,
    readTaskFlowStageSummaries: async (input) => {
      const result = await readStageSummaries(input)
      return {
        ...result,
        items: result.items.filter((item) => item.stage.id !== hostedStage.id),
      }
    },
  })
  await expect(listWorkflowCursors({ session: context.session }, database)).rejects.toThrow(
    `workflow cursor fixture#1 was listed, but its stage summary could not be read; retry \`${workflowCursorListCommand}\``,
  )
})
