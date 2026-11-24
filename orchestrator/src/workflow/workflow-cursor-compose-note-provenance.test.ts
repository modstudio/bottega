import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import type { HubNote } from '../mcp/hub-notes.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import type { ListWorkflowNotesPort } from './workflow-cursor-compose.ts'
import { seedCurrentWorkflowTreeFixture } from './workflow-store.fixture.ts'

const database = testDatabaseFixture((d) => {
  seedCurrentWorkflowTreeFixture(d, ['plan-task'], 'note provenance compose fixture')
})

const note = (promotedTask: string): HubNote => ({
  record_id: newRecordId(),
  label: 'fixture#3',
  text: 'Promoted defect.',
  stale_at: null,
  stale_reason: null,
  promoted_task: promotedTask,
  created_at: '2026-11-24T00:00:00.000Z',
  last_seen_at: '2026-11-24T00:00:00.000Z',
})

const compose = (d: Database, key: string, listNotes: ListWorkflowNotesPort) =>
  composeWorkflowWithCursor(
    'plan-task',
    'fixture',
    'feature',
    { key },
    { session: `session-${key}`, workflowKey: key, taskRecordId: `task-${key}` },
    d,
    {},
    {},
    undefined,
    undefined,
    undefined,
    listNotes,
  )

test('cursor creation refuses plan-task for a note-promoted key', async () => {
  const d = database()
  await expect(compose(d, 'DEV-7', async () => [note('DEV-7')])).rejects.toThrow(
    'task DEV-7 was promoted from note fixture#3',
  )
  expect(d.query('SELECT COUNT(*) AS count FROM workflow_cursor').get()).toEqual({
    count: 0,
  })
})

test('cursor creation allows plan-task for a key with no promotion provenance', async () => {
  await expect(compose(database(), 'DEV-8', async () => [note('DEV-7')])).resolves.toMatchObject({
    cursor: { opened: true },
  })
})

test('cursor creation refuses plan-task when provenance cannot be read', async () => {
  await expect(
    compose(database(), 'DEV-9', async () => {
      throw new Error('record unavailable')
    }),
  ).rejects.toThrow('note-promotion provenance could not be read: record unavailable')
})

test('resuming an existing plan-task cursor does not reread provenance', async () => {
  const d = database()
  let reads = 0
  const listNotes = async () => {
    reads += 1
    return []
  }
  await compose(d, 'DEV-10', listNotes)
  const resumed = await compose(d, 'DEV-10', listNotes)
  expect(resumed).toMatchObject({ cursor: { opened: false } })
  expect(reads).toBe(1)
})
