import { expect, test } from 'bun:test'
import { filedIssueQueueState } from '../issue/issue-dispatch.ts'
import { lookupProjectTasks } from './project-task-lookup.ts'
import { readProjectTaskList } from './project-task-list.ts'
import { installTaskReader, type TaskReadPort, type TaskReadRow } from './task-read-port.ts'

const BRIEF_RECORD_TASK_CALL_LIMIT = 4
const REVIEW_RECORD_TASK_CALL_LIMIT = 5
const WAITING_RECORD_TASK_CALL_LIMIT = 3
const STOP_RECORD_TASK_CALL_LIMIT = 3

test('hook task reads use lookup and status-filtered lists within their call budgets', async () => {
  const tasks: TaskReadRow[] = Array.from({ length: 600 }, (_, index) => ({
    key: `DEV-${index + 1}`,
    record_id: `task-${index + 1}`,
    project: 'bottega',
    title: 'ordinary task',
    parent_key: null,
    source: 'local',
    status: 'open',
    status_category: 'open',
    last_seen: null,
    body: null,
    opened_at: null,
  }))
  const calls: Array<{ operation: 'list' | 'lookup'; status?: string }> = []
  const port: TaskReadPort = {
    async list(filters = {}) {
      calls.push({ operation: 'list', status: filters.status })
      if (!filters.status) throw new Error('unfiltered project task scan on a hook path')
      return tasks.filter((task) => task.status_category === filters.status)
    },
    async lookup(_project, keys) {
      calls.push({ operation: 'lookup' })
      return tasks.filter((task) => keys.includes(task.key))
    },
    duplicates: async () => [],
    show: async () => ({ task: tasks[0]! }),
    documents: async () => [],
    document: async () => ({
      id: 'document',
      label: 'DEV-1/1',
      task_record_id: 'task-1',
      title: 'fixture',
      body: '',
      version: '1',
    }),
  }
  installTaskReader(port)

  await lookupProjectTasks('bottega', ['DEV-1'])
  await filedIssueQueueState(null, (project, filters) => readProjectTaskList(project, filters))
  expect(calls).toHaveLength(BRIEF_RECORD_TASK_CALL_LIMIT)

  await lookupProjectTasks('bottega', ['DEV-1'])
  expect(calls).toHaveLength(REVIEW_RECORD_TASK_CALL_LIMIT)

  calls.length = 0
  await filedIssueQueueState(null, (project, filters) => readProjectTaskList(project, filters))
  expect(calls).toHaveLength(WAITING_RECORD_TASK_CALL_LIMIT)

  calls.length = 0
  await Promise.all(
    ['open', 'active', 'review'].map((status) => readProjectTaskList('bottega', { status })),
  )
  expect(calls).toHaveLength(STOP_RECORD_TASK_CALL_LIMIT)
  expect(calls.every((call) => call.operation === 'lookup' || call.status !== undefined)).toBe(true)
})
