import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
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
    key: index === 599 ? 'DEV-1844/2' : `DEV-${index + 1}`,
    record_id: `task-${index + 1}`,
    project: 'fixture',
    title: 'ordinary task',
    parent_key: null,
    status: index === 599 ? 'done' : 'open',
    status_category: index === 599 ? 'done' : 'open',
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
  const cursor = d
    .query<{ updated_at: string }, [number]>(
      'SELECT updated_at FROM workflow_cursor WHERE number=?',
    )
    .get(opened.cursor!.id)
  const itemAt = new Date(Date.parse(cursor!.updated_at) + 1).toISOString()
  d.query('UPDATE workflow_cursor SET workflow_key=?,task_record_id=? WHERE number=?').run(
    'DEV-1',
    'task-1',
    opened.cursor!.id,
  )
  d.query(
    `INSERT INTO context_item
     (record_id,holder_kind,holder_id,slug,kind,body,source,created_at,updated_at)
     VALUES (?,'task',?,'slice-reference','fact',?,'test',?,?)`,
  ).run(
    newRecordId(),
    'task-1',
    'DEV-1844/2 is complete and this note is stale.',
    itemAt,
    itemAt,
  )
  d.query(
    `INSERT INTO hook_emission
     (record_id,session_id,at,event,hook,kind,chars,lines,text_hash)
     VALUES (?,?,?,'PreToolUse','context-review','additionalContext',0,0,?)`,
  ).run(newRecordId(), session, '2026-11-20T10:00:00Z', '0'.repeat(64))

  const result = await reviewContext(session, {
    database: d,
    now: () => Date.parse('2026-11-21T12:00:00Z'),
  })

  expect(calls).toHaveLength(REVIEW_RECORD_TASK_CALL_LIMIT)
  expect(calls.every((call) => call.operation !== 'list' || call.status !== undefined)).toBe(true)
  expect(result).toEqual(
    expect.objectContaining({
      due: true,
      review: expect.stringContaining('names done task DEV-1844/2'),
    }),
  )
  installTaskReader(undefined as never)
})
