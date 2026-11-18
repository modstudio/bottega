import { afterEach, expect, test } from 'bun:test'
import { resolvedRecordOrigin } from '../../../shared/record-api-url.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { guardHostedTables } from '../database/hosted-table-guard.ts'
import { rememberActiveRecordSpace } from '../project-space.ts'
import { rememberProjectSpace } from '../project-space-cache.ts'
import { TASK_FLOW_STAGE_STATES } from '../record/record-task-flow-contract.ts'
import { taskFlowReadStore } from './task-flow-store.ts'
import {
  abandonSelectedWorkflowCursorForClose,
  awaitWorkflowRuling,
  composeWorkflowWithCursor,
} from './workflow-cursor.ts'
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

afterEach(() => {
  installRecordApiClient(null)
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
  raw
    .query('INSERT INTO record_install_binding (id,bound_at,record_origin) VALUES (1,?,?)')
    .run('2026-11-15T00:00:00.000Z', resolvedRecordOrigin())

  const database = guardHostedTables(raw, taskFlowTables)
  const memory = createMemoryRecordApiClient({
    taskFlowComposeEnforcement: 'note-only',
  })
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
  const attachment = await attachWorkflowTextByHandle(
    cursor,
    'Hosted attachment.',
    context,
    database,
  )
  const copied = await copyWorkflowTextForCursor(
    {
      recordId: hosted.stage.id,
      number: cursor,
      project: 'fixture',
      taskKey,
      taskRecordId: taskId,
      state: hosted.stage.state,
    },
    database,
    async () => [{ key: taskKey, record_id: taskId, project: 'fixture', source: 'local' }],
    {
      list: async () => [],
      create: async () => 'DEV-HOSTED-GUARD/1',
    },
    taskFlowClient,
  )
  expect(copied.copied).toHaveLength(1)
  await deleteWorkflowText(hosted.stage.id, true, database, taskFlowClient)
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
  expect(
    (await listWorkflowCursors({ all: true, project: 'fixture' }, database)).map(
      (row) => row.state,
    ),
  ).toEqual(['abandoned'])
})
