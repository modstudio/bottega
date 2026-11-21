import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { filedIssueQueueState } from '../issue/issue-dispatch.ts'
import { readProjectTaskList } from './project-task-list.ts'
import { lookupProjectTasks } from './project-task-lookup.ts'
import { installTaskReader, type TaskReadPort } from './task-read-port.ts'

const invalidRowPort: TaskReadPort = {
  lookup: async () => [],
  list: async () => [
    {
      key: 'DEV-1',
      record_id: 'task-1',
      project: 'fixture',
      title: null,
      parent_key: null,
      source: null,
      status: null,
      status_category: 42 as unknown as string,
      last_seen: null,
      body: null,
      opened_at: null,
    },
  ],
  show: async () => {
    throw new Error('not used')
  },
  duplicates: async () => [],
  documents: async () => [],
  document: async () => {
    throw new Error('not used')
  },
}

test('project-wide task lists validate every returned row', async () => {
  installTaskReader(invalidRowPort)
  await expect(readProjectTaskList('fixture')).rejects.toThrow(
    'response contained an invalid task status category',
  )
})

const BRIEF_RECORD_TASK_CALL_LIMIT = 4
const REVIEW_RECORD_TASK_CALL_LIMIT = 5
const WAITING_RECORD_TASK_CALL_LIMIT = 3
const STOP_RECORD_TASK_CALL_LIMIT = 3

test('hook task reads use lookup and status-filtered lists within their call budgets', async () => {
  const tasks: import('./task-read-port.ts').TaskReadRow[] = Array.from(
    { length: 600 },
    (_, index) => ({
      key: `DEV-${index + 1}`,
      record_id: `task-${index + 1}`,
      project: PLATFORM_SLUG,
      title: 'ordinary task',
      parent_key: null,
      source: 'local',
      status: 'open',
      status_category: 'open',
      last_seen: null,
      body: null,
      opened_at: null,
    }),
  )
  const calls: Array<{ operation: 'list' | 'lookup'; status?: string }> = []
  installTaskReader({
    ...invalidRowPort,
    async list(filters = {}) {
      calls.push({ operation: 'list', status: filters.status })
      if (!filters.status) throw new Error('unfiltered project task scan on a hook path')
      return tasks.filter((task) => task.status_category === filters.status)
    },
    async lookup(_project, keys) {
      calls.push({ operation: 'lookup' })
      return tasks.filter((task) => keys.includes(task.key))
    },
  })

  await lookupProjectTasks(PLATFORM_SLUG, ['DEV-1'])
  await filedIssueQueueState(null, (project, filters) => readProjectTaskList(project, filters))
  expect(calls).toHaveLength(BRIEF_RECORD_TASK_CALL_LIMIT)

  await lookupProjectTasks(PLATFORM_SLUG, ['DEV-1'])
  expect(calls).toHaveLength(REVIEW_RECORD_TASK_CALL_LIMIT)

  calls.length = 0
  await filedIssueQueueState(null, (project, filters) => readProjectTaskList(project, filters))
  expect(calls).toHaveLength(WAITING_RECORD_TASK_CALL_LIMIT)

  calls.length = 0
  await Promise.all(
    ['open', 'active', 'review'].map((status) => readProjectTaskList(PLATFORM_SLUG, { status })),
  )
  expect(calls).toHaveLength(STOP_RECORD_TASK_CALL_LIMIT)
  expect(calls.every((call) => call.operation === 'lookup' || call.status !== undefined)).toBe(true)
  installTaskReader(undefined as never)
})
