import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { boardClaimTake } from '../board/board-operations.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import {
  installTaskReader,
  type TaskReadPort,
  type TaskReadRow,
} from '../workflow/task-read-port.ts'
import { composeWorkflowWithCursor } from '../workflow/workflow-cursor.ts'
import { seedCurrentWorkflowTreeFixture } from '../workflow/workflow-store.fixture.ts'
import { composeWorkflow } from '../workflow/workflows.ts'
import { sessionEpicWork } from './session-epic-work.ts'

const STOP_RECORD_TASK_CALL_LIMIT = 4
const database = testDatabaseFixture((d) => {
  seedCurrentWorkflowTreeFixture(d, ['plan-task'], 'session epic work fixture')
})

const task = (
  key: string,
  parentKey: string | null,
  statusCategory = 'open',
  hasChildren = false,
): TaskReadRow & { has_children: boolean } => ({
  key,
  record_id: `task-${key}`,
  project: 'fixture',
  title: key,
  parent_key: parentKey,
  source: 'fixture',
  status: statusCategory,
  status_category: statusCategory,
  last_seen: null,
  body: null,
  opened_at: null,
  has_children: hasChildren,
})

function installGuardReader(tasks: Array<TaskReadRow & { has_children: boolean }>) {
  const calls: Array<{ operation: 'list' | 'lookup'; status?: string }> = []
  const byKey = new Map(tasks.map((row) => [row.key, row]))
  const port: TaskReadPort = {
    async list(filters = {}) {
      calls.push({ operation: 'list', status: filters.status })
      if (!filters.status) throw new Error('unfiltered project task scan on a hook path')
      return tasks.filter(
        (row) => row.project === filters.project && row.status_category === filters.status,
      )
    },
    async lookup(_project, keys) {
      calls.push({ operation: 'lookup' })
      const found = new Map<string, TaskReadRow & { has_children: boolean }>()
      for (const key of keys) {
        let row = byKey.get(key)
        while (row && !found.has(row.key)) {
          found.set(row.key, row)
          row = row.parent_key ? byKey.get(row.parent_key) : undefined
        }
      }
      return [...found.values()]
    },
    show: async (key) => ({ task: byKey.get(key)! }),
    duplicates: async () => [],
    documents: async () => [],
    document: async () => {
      throw new Error('not used')
    },
  }
  installTaskReader(port)
  return calls
}

async function openEpicAtStart(d: Database, session: string) {
  const shape = composeWorkflow('plan-task', 'fixture', 'feature', { key: 'DEV-1' }, d)
  const opened = await composeWorkflowWithCursor(
    'plan-task',
    'fixture',
    'feature',
    { key: 'DEV-1' },
    {
      session,
      workflowKey: 'DEV-1',
      taskRecordId: 'task-DEV-1',
      taskStatusCategory: 'open',
    },
    d,
    {},
    {},
    undefined,
    {
      take: ({ project, key, session: holder }) =>
        boardClaimTake(
          { project, subject: `task:${key}` },
          { database: d, cwd: '/fixture', taskCursorAuthority: { mode: 'take', session: holder } },
        ),
      release: async () => ({ released: 0 }),
    },
  )
  const start = shape.steps.findIndex(({ slug }) => slug === 'start')
  d.query('UPDATE workflow_cursor SET ordinal=?,step_slug=? WHERE number=?').run(
    start,
    'start',
    opened.cursor!.id,
  )
}

test('sessionEpicWork uses filtered lists plus lookup ancestry within its task-call budget', async () => {
  const d = database()
  const session = 'stop-hook-session'
  const tasks = [
    task('DEV-1', null, 'open', true),
    task('DEV-2', 'DEV-1', 'done', true),
    task('DEV-3', 'DEV-2'),
    ...Array.from({ length: 597 }, (_, index) => task(`DEV-${index + 100}`, null)),
  ]
  const calls = installGuardReader(tasks)
  await openEpicAtStart(d, session)

  const sessionStages = await taskFlowReadStore(d).listOpenStages({ sessionId: session })
  const surfaces = await sessionEpicWork(session, sessionStages, d)

  expect(calls).toHaveLength(STOP_RECORD_TASK_CALL_LIMIT)
  expect(calls.every((call) => call.operation !== 'list' || call.status !== undefined)).toBe(true)
  expect(surfaces).toEqual([expect.objectContaining({ epic: 'DEV-1', open: ['DEV-3'], queue: [] })])
  installTaskReader(undefined as never)
})
