import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { getWorkflowStepWithCursor } from './workflow-cursor-serve.ts'
import { seedCurrentWorkflowTreeFixture } from './workflow-store.fixture.ts'
import { attachWorkflowTextByHandle } from './workflow-text.ts'
import {
  copyWorkflowTextForTask,
  cursorForWorkflowTextCopy,
  type WorkflowTaskDocument,
  type WorkflowTextDocumentPorts,
  workflowTextCopyReport,
} from './workflow-text-copy.ts'

const context = { session: 'graduation-owner' }
const task = { key: 'DEV-2289', record_id: 'task-dev-2289', project: 'fixture', source: 'local' }

const database = testDatabaseFixture((d) => {
  seedCurrentWorkflowTreeFixture(d, ['explore'], 'graduation fixture')
  // Cursor handles resolve their project from the working directory.
  d.query("UPDATE project SET path=? WHERE name='fixture'").run(process.cwd())
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

test('graduation copies every explore attachment into the target task documents', async () => {
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
})

test('a keyless cursor with uncopied text refuses copy without --task and names the remedy', async () => {
  const { d, cursor } = await openExplore()
  await attachWorkflowTextByHandle(cursor, 'finding', context, d)

  await expect(
    copyWorkflowTextForTask(
      await cursorForWorkflowTextCopy(cursor, d),
      undefined,
      d,
      async () => [],
      documentFake().ports,
    ),
  ).rejects.toThrow(
    `cursor ${cursor} is not linked to a task; copy it with ${PLATFORM_SLUG} workflow text copy --cursor ${cursor} --task <KEY>`,
  )
})

test('a failed explicit-task copy retains --task in its retry command', async () => {
  const { d, cursor } = await openExplore()
  await attachWorkflowTextByHandle(cursor, 'finding', context, d)
  const fake = documentFake()
  fake.ports.create = async () => {
    throw new Error('document store refused the write')
  }

  const result = await copyWorkflowTextForTask(
    await cursorForWorkflowTextCopy(cursor, d),
    task.key,
    d,
    async () => [task],
    fake.ports,
  )

  expect(workflowTextCopyReport(result)).toContain(
    `${PLATFORM_SLUG} workflow text copy --cursor ${cursor} --task ${task.key}`,
  )
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
