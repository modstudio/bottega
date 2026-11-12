import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { promoteStepCatalogueLocal, setStepCatalogueLocal } from './step-catalogue.ts'
import { getWorkflowStepWithCursor } from './workflow-cursor-serve.ts'
import {
  copyWorkflowTextForTask,
  cursorForWorkflowTextCopy,
  type WorkflowTaskDocument,
  type WorkflowTextDocumentPorts,
} from './workflow-text-copy.ts'
import { attachWorkflowTextByHandle } from './workflow-text.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { parseWorkflowTree } from './workflow-tree.ts'
import { collectWorkflowTree } from './workflow-tree-files.ts'
import { composeWorkflow, promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

const context = { session: 'graduation-owner' }
const task = { key: 'DEV-2289', record_id: 'task-dev-2289', project: 'fixture', source: 'local' }
const root = fileURLToPath(new URL('../../..', import.meta.url))
const tree = parseWorkflowTree(collectWorkflowTree(root))

const database = testDatabaseFixture((d) => {
  seedWorkflows(d)
  d.query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)').run(
    newRecordId(),
    'fixture',
    '/fixture',
    'bun',
    JSON.stringify({ tracker: { protocol: 'hub' }, docs: { protocol: 'orch-docs' } }),
  )
  const catalogue = setStepCatalogueLocal(
    { steps: tree.steps, sequences: tree.sequences },
    'graduation fixture',
    'test',
    d,
  )
  promoteStepCatalogueLocal(catalogue.n, 'graduation fixture', 'test', d)
  for (const tracked of tree.workflows.filter(({ slug }) =>
    ['explore', 'plan-task'].includes(slug),
  )) {
    const workflow = setWorkflowLocal(
      tracked.slug,
      tracked.definition,
      'graduation fixture',
      'test',
      d,
    )
    promoteWorkflowLocal(tracked.slug, workflow.n, 'graduation fixture', 'test', d)
  }
})

function documentFake(): {
  ports: WorkflowTextDocumentPorts
  documents: (WorkflowTaskDocument & { taskKey: string; body: string })[]
} {
  const documents: (WorkflowTaskDocument & { taskKey: string; body: string })[] = []
  return {
    documents,
    ports: {
      async list(taskKey) {
        return documents.filter((document) => document.taskKey === taskKey)
      },
      async create(taskKey, _project, title, body) {
        const reference = `${taskKey}/${documents.length + 1}`
        documents.push({ taskKey, title, body, reference })
        return reference
      },
    },
  }
}

async function openExplore() {
  const d = database()
  const opened = await getWorkflowStepWithCursor(
    'explore',
    'fixture',
    'frame',
    {},
    'default',
    context,
    d,
    {},
  )
  return { d, cursor: opened.cursor }
}

test('graduation copies every explore attachment into the task documents read by plan-task', async () => {
  const { d, cursor } = await openExplore()
  await attachWorkflowTextByHandle(cursor, 'first finding', context, d)
  await attachWorkflowTextByHandle(cursor, 'second finding', context, d)
  const fake = documentFake()

  const result = await copyWorkflowTextForTask(
    await cursorForWorkflowTextCopy(cursor, d),
    task.key,
    d,
    async () => [task],
    fake.ports,
  )

  expect(result.copied).toHaveLength(2)
  expect(fake.documents.map(({ taskKey, body }) => ({ taskKey, body }))).toEqual([
    { taskKey: task.key, body: 'first finding' },
    { taskKey: task.key, body: 'second finding' },
  ])
  expect(
    composeWorkflow('plan-task', 'fixture', 'feature', { key: task.key }, d).steps,
  ).toContainEqual(expect.objectContaining({ slug: 'discover' }))
  expect(await fake.ports.list(task.key, task.project)).toHaveLength(2)
})

test('--task refuses a keyed cursor and names its own task', async () => {
  const { d, cursor } = await openExplore()
  d.query('UPDATE workflow_cursor SET workflow_key=?,task_record_id=? WHERE number=?').run(
    task.key,
    task.record_id,
    cursor,
  )

  await expect(
    copyWorkflowTextForTask(
      await cursorForWorkflowTextCopy(cursor, d),
      'DEV-9999',
      d,
      async () => [task],
      documentFake().ports,
    ),
  ).rejects.toThrow(`cursor ${cursor} belongs to task ${task.key}`)
})

test('an unknown target task names how to find or create it', async () => {
  const { d, cursor } = await openExplore()

  await expect(
    copyWorkflowTextForTask(
      await cursorForWorkflowTextCopy(cursor, d),
      'DEV-9999',
      d,
      async () => [],
      documentFake().ports,
    ),
  ).rejects.toThrow(
    `find it with ${PLATFORM_SLUG} task list --project fixture --json or create it with ${PLATFORM_SLUG} task new --project fixture`,
  )
})
