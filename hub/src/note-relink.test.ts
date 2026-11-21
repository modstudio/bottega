import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { declareFixtureProjectSpace } from '../test/fixture-project-space.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { persistInstallBinding } from './install-binding.ts'
import { createNote, getNote, promoteNote, relinkNote } from './note.ts'
import type { HostedPushChange } from './push-contract.ts'
import { createLocalTaskInTransaction } from './task.ts'

const workshop = declareFixtureProjectSpace('workshop', 'workshop')
const previousHostedUrl = process.env.BOTTEGA_HOSTED_URL
const previousTracker = workshop().settings.tracker

beforeAll(() => {
  delete process.env.BOTTEGA_HOSTED_URL
})
beforeEach(resetFixtureStore)
beforeEach(() => {
  delete workshop().settings.space
  workshop().settings.tracker = { protocol: 'hub' }
})
afterAll(() => {
  workshop().settings.tracker = previousTracker
  if (previousHostedUrl === undefined) delete process.env.BOTTEGA_HOSTED_URL
  else process.env.BOTTEGA_HOSTED_URL = previousHostedUrl
  resetFixtureStore()
})

test('relink rolls back the attachment when its history comment cannot be written', async () => {
  const note = (
    await createNote({
      text: `Relink rollback ${crypto.randomUUID()}`,
      cwd: '/fixtures/repos/workshop',
      forceNew: true,
    })
  ).note
  const [previous, target] = writeTransaction((conn) => [
    createLocalTaskInTransaction(
      conn,
      { project: 'workshop', title: 'Rollback previous task' },
      { skipDuplicateCheck: true },
    ),
    createLocalTaskInTransaction(
      conn,
      { project: 'workshop', title: 'Rollback target task' },
      { skipDuplicateCheck: true },
    ),
  ])
  await promoteNote(note.record_id, { existingTaskKey: previous.key })
  workshop().settings.space = 'workshop'
  writeTransaction((conn) => persistInstallBinding(conn, 'space-a'))
  const pushed: HostedPushChange[] = []
  const hosted = {
    baseUrl: 'https://hub.example.test',
    token: 'test',
    fetch: async (input: string, init?: RequestInit) => {
      const url = new URL(input)
      if (url.pathname === '/v1/tasks/identity')
        return Response.json({
          userId: 'user-1',
          activeSpaceId: 'space-a',
          memberships: [{ spaceId: 'space-a', slug: 'workshop', permission: 'write' }],
          capabilities: {
            spacePush: true,
            spacePushTables: ['hub_note', 'hub_task_comment'],
          },
        })
      if (url.pathname === '/v1/changes') {
        const changes = JSON.parse(String(init?.body)) as HostedPushChange[]
        pushed.push(...changes)
        return Response.json(changes.map(({ id }) => ({ id, status: 'applied' })))
      }
      return Response.json({ error: 'unexpected route' }, { status: 500 })
    },
  }
  writeTransaction((conn) =>
    conn.exec(`
      CREATE TEMP TRIGGER fail_relink_comment
      BEFORE INSERT ON task_comment
      BEGIN
        SELECT RAISE(ABORT, 'forced comment failure');
      END
    `),
  )
  try {
    await expect(
      relinkNote(note.record_id, target.key, 'must remain atomic', { hosted }),
    ).rejects.toThrow('forced comment failure')
  } finally {
    writeTransaction((conn) => conn.exec('DROP TRIGGER fail_relink_comment'))
  }

  expect(getNote(note.record_id).promoted_task).toBe(previous.key)
  expect(
    db()
      .query<{ promoted_task_record_id: string }, [string]>(
        'SELECT promoted_task_record_id FROM note WHERE record_id=?',
      )
      .get(note.record_id),
  ).toEqual({ promoted_task_record_id: previous.record_id })
  expect(db().query('SELECT 1 FROM hosted_outbox').all()).toHaveLength(0)
  expect(pushed).toHaveLength(0)
})

test('hosted relink queues the attachment fields and both history comments', async () => {
  const note = (
    await createNote({
      text: `Hosted relink ${crypto.randomUUID()}`,
      cwd: '/fixtures/repos/workshop',
      forceNew: true,
    })
  ).note
  const [previous, target] = writeTransaction((conn) => [
    createLocalTaskInTransaction(
      conn,
      { project: 'workshop', title: 'Hosted previous task' },
      { skipDuplicateCheck: true },
    ),
    createLocalTaskInTransaction(
      conn,
      { project: 'workshop', title: 'Hosted target task' },
      { skipDuplicateCheck: true },
    ),
  ])
  await promoteNote(note.record_id, { existingTaskKey: previous.key })
  workshop().settings.space = 'workshop'
  writeTransaction((conn) => persistInstallBinding(conn, 'space-a'))
  const pushed: HostedPushChange[] = []
  const hosted = {
    baseUrl: 'https://hub.example.test',
    token: 'test',
    fetch: async (input: string, init?: RequestInit) => {
      const url = new URL(input)
      if (url.pathname === '/v1/tasks/identity')
        return Response.json({
          userId: 'user-1',
          activeSpaceId: 'space-a',
          memberships: [{ spaceId: 'space-a', slug: 'workshop', permission: 'write' }],
          capabilities: {
            spacePush: true,
            spacePushTables: ['hub_note', 'hub_task_comment'],
          },
        })
      if (url.pathname === '/v1/changes') {
        const changes = JSON.parse(String(init?.body)) as HostedPushChange[]
        pushed.push(...changes)
        return Response.json(changes.map(({ id }) => ({ id, status: 'applied' })))
      }
      return Response.json({ error: 'unexpected route' }, { status: 500 })
    },
  }

  await relinkNote(note.record_id, target.key, 'hosted trail', { hosted })

  expect(pushed).toHaveLength(3)
  expect(pushed.find((change) => change.table === 'hub_note')).toMatchObject({
    fields: ['promoted_task', 'promoted_task_id', 'last_seen_at'],
    row: { promoted_task: target.key, promoted_task_id: target.record_id },
  })
  expect(
    pushed.flatMap((change) =>
      change.table === 'hub_task_comment' && change.op === 'upsert' ? [change.row.body] : [],
    ),
  ).toEqual([
    `note ${note.label} relinked from ${previous.key}: hosted trail`,
    `note ${note.label} relinked to ${target.key}: hosted trail`,
  ])
})

test('relink refuses a tracker-owned project with the task-comment cause', async () => {
  const note = (
    await createNote({
      text: `Tracker relink ${crypto.randomUUID()}`,
      cwd: '/fixtures/repos/workshop',
      forceNew: true,
    })
  ).note
  const [previous, target] = writeTransaction((conn) => [
    createLocalTaskInTransaction(
      conn,
      { project: 'workshop', title: 'Tracker previous task' },
      { skipDuplicateCheck: true },
    ),
    createLocalTaskInTransaction(
      conn,
      { project: 'workshop', title: 'Tracker target task' },
      { skipDuplicateCheck: true },
    ),
  ])
  await promoteNote(note.record_id, { existingTaskKey: previous.key })
  workshop().settings.tracker = { protocol: 'workspace-mcp' }

  await expect(relinkNote(note.record_id, target.key, 'tracker trail')).rejects.toThrow(
    'tasks are tracker-owned, and relink records its trail as task comments in the hub',
  )
  expect(getNote(note.record_id).promoted_task).toBe(previous.key)
})
