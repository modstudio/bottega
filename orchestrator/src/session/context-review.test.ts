import { expect, test } from 'bun:test'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import {
  installTaskReader,
  type TaskLookupRow,
  type TaskReadPort,
} from '../workflow/task-read-port.ts'
import { composeWorkflowWithCursor } from '../workflow/workflow-cursor.ts'
import { seedCurrentWorkflowTreeFixture } from '../workflow/workflow-store.fixture.ts'
import { contextReviewTaskKeys, reviewContext } from './context-review.ts'

const REVIEW_RECORD_TASK_CALL_LIMIT = 5
const database = testDatabaseFixture((d) => {
  seedCurrentWorkflowTreeFixture(d, ['explore'], 'context review fixture')
})

test('context-review task key extraction retains slice suffixes', () => {
  expect(contextReviewTaskKeys('DEV-1844/2 is done; dev-1844/2 is repeated.')).toEqual([
    'DEV-1844/2',
    'DEV-1844/2',
  ])
})

test('reviewContext drives the brief and its own lookup within the task-call budget', async () => {
  const d = database()
  const session = 'context-review-task-read-guard'
  const calls: Array<{ operation: 'list' | 'lookup'; status?: string; keys?: string[] }> = []
  const tasks: TaskLookupRow[] = Array.from({ length: 600 }, (_, index) => ({
    key: `DEV-${index + 1}`,
    record_id: `task-${index + 1}`,
    project: 'fixture',
    title: 'ordinary task',
    parent_key: null,
    status: 'open',
    status_category: 'open',
    last_seen: null,
    opened_at: null,
    has_children: false,
  }))
  const port: TaskReadPort = {
    async list(filters = {}) {
      calls.push({ operation: 'list', status: filters.status })
      if (!filters.status) throw new Error('unfiltered project task scan on a hook path')
      return []
    },
    async lookup(project, keys) {
      calls.push({ operation: 'lookup', keys })
      return tasks.filter((task) => task.project === project && keys.includes(task.key))
    },
    show: async () => {
      throw new Error('not used')
    },
    duplicates: async () => [],
    documents: async () => [],
    document: async () => {
      throw new Error('not used')
    },
  }
  installTaskReader(port)
  const opened = await composeWorkflowWithCursor(
    'explore',
    'fixture',
    'default',
    {},
    { session },
    d,
    {},
    {},
  )
  d.query('UPDATE workflow_cursor SET workflow_key=?,task_record_id=? WHERE number=?').run(
    'DEV-1',
    'task-1',
    opened.cursor!.id,
  )

  await reviewContext(session, { database: d, now: () => Date.parse('2026-11-21T12:00:00Z') })

  expect(calls).toHaveLength(REVIEW_RECORD_TASK_CALL_LIMIT)
  expect(calls.every((call) => call.operation !== 'list' || call.status !== undefined)).toBe(true)
  installTaskReader(undefined as never)
})
