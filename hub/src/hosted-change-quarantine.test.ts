import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { pullHostedChanges } from './hosted-change-cache.ts'
import { hostedChangeQuarantineRows } from './hosted-change-quarantine.ts'
import type { HostedSend } from './hosted-reports.ts'
import type { HostedTask } from './hosted-tasks.ts'

beforeEach(resetFixtureStore)

const at = '2026-10-09T12:00:00.000Z'
const taskId = '01990000-0000-7000-8000-000000001270'
const sendId = '01990000-0000-7000-8000-000000001271'
const options = {
  baseUrl: 'https://hub.example.test',
  token: 'session',
  personalSpaceId: 'space-one',
  registeredProjects: [{ name: 'one', settings: { space: 'one' } }],
} as const
const identity = {
  userId: 'user-one',
  activeSpaceId: 'space-one',
  memberships: [{ spaceId: 'space-one', slug: 'one' }],
  capabilities: {
    recordChanges: true,
    projectNoteCounters: true,
    targetSpaceNotes: true,
  },
}

const task = (statusCategory: HostedTask['status_category'] | string): HostedTask =>
  ({
    id: taskId,
    key: 'DEV-1270',
    project: 'one',
    project_name: 'one',
    title: 'quarantine probe',
    status: 'open',
    status_category: statusCategory,
    parent_key: null,
    body: null,
    assignee: null,
    opened_at: at,
    closed_at: null,
    source: 'local',
    first_seen: at,
    last_seen: at,
    created_at: at,
    updated_at: at,
    deleted_at: null,
    next_document_number: 1,
  }) as HostedTask

const send = (): HostedSend => ({
  id: sendId,
  at,
  window: 'day',
  recipients: '["one@example.test"]',
  projects: '["one"]',
  items: 1,
  status: 'sent',
  error: null,
  test: 0,
  created_at: at,
  machine: 'machine-one',
  recipient_details: [{ user_id: null, name: 'One', email: 'one@example.test' }],
})

function seedFeed(cursor = 'before') {
  writeTransaction((conn) => {
    conn
      .query('INSERT INTO setting(key,value) VALUES (?,?)')
      .run('collect.hosted-record-changes.cursor', cursor)
    conn
      .query('INSERT INTO setting(key,value) VALUES (?,?)')
      .run(
        'collect.hosted-record-changes.spaces',
        JSON.stringify({ task: ['space-one'], note: ['space-one'], send: ['space-one'] }),
      )
  })
}

function feed(changes: unknown[], cursors = ['after']) {
  let call = 0
  return async (input: string) => {
    const url = new URL(input)
    if (url.pathname === '/v1/tasks/identity') return Response.json(identity)
    if (url.pathname === '/v1/changes')
      return Response.json({
        changes,
        cursor: cursors[call++] ?? cursors.at(-1)!,
        lag: 0,
        more: false,
      })
    throw new Error(`unexpected route ${url.pathname}`)
  }
}

const badChange = () => ({
  table: 'hub_task',
  id: taskId,
  space: 'space-one',
  op: 'upsert',
  row: task('not-a-category'),
})

test('a constraint row is quarantined while the page continues and advances', async () => {
  seedFeed()
  await pullHostedChanges({
    ...options,
    fetch: feed([
      badChange(),
      { table: 'hub_send', id: sendId, space: 'space-one', op: 'upsert', row: send() },
    ]),
  })

  expect(
    db()
      .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?')
      .get('collect.hosted-record-changes.cursor'),
  ).toEqual({ value: 'after' })
  expect(db().query('SELECT 1 FROM send WHERE record_id=?').get(sendId)).not.toBeNull()
  expect(db().query('SELECT 1 FROM task WHERE record_id=?').get(taskId)).toBeNull()
  expect(db().query('SELECT 1 FROM install_binding').get()).toBeNull()
  expect(hostedChangeQuarantineRows(db())).toEqual([
    expect.objectContaining({
      feed: 'task',
      spaceId: 'space-one',
      table: 'hub_task',
      rowId: taskId,
      constraintError: expect.stringContaining('CHECK constraint failed'),
      sightings: 1,
    }),
  ])
  expect(hostedChangeQuarantineRows(db())[0]!.rawChange).toContain('not-a-category')
})

test('seeing the same bad row again increments its quarantine sighting', async () => {
  seedFeed()
  let pass = 0
  const fetch = async (input: string) => {
    const url = new URL(input)
    if (url.pathname === '/v1/tasks/identity') return Response.json(identity)
    if (url.pathname === '/v1/changes')
      return Response.json({
        changes: [badChange()],
        cursor: pass++ ? 'after' : 'middle',
        lag: 0,
        more: false,
      })
    throw new Error(`unexpected route ${url.pathname}`)
  }

  await pullHostedChanges({ ...options, fetch })
  await pullHostedChanges({ ...options, fetch })

  expect(hostedChangeQuarantineRows(db())).toEqual([expect.objectContaining({ sightings: 2 })])
})

test('a later successful change clears the quarantine for that row', async () => {
  seedFeed()
  let pass = 0
  const fetch = async (input: string) => {
    const url = new URL(input)
    if (url.pathname === '/v1/tasks/identity') return Response.json(identity)
    if (url.pathname === '/v1/changes') {
      pass += 1
      return Response.json({
        changes: [
          {
            ...badChange(),
            row: task(pass === 1 ? 'not-a-category' : 'open'),
          },
        ],
        cursor: pass === 1 ? 'middle' : 'after',
        lag: 0,
        more: false,
      })
    }
    throw new Error(`unexpected route ${url.pathname}`)
  }

  await pullHostedChanges({ ...options, fetch })
  expect(hostedChangeQuarantineRows(db())).toHaveLength(1)
  await pullHostedChanges({ ...options, fetch })

  expect(hostedChangeQuarantineRows(db())).toEqual([])
  expect(db().query('SELECT status_category FROM task WHERE record_id=?').get(taskId)).toEqual({
    status_category: 'open',
  })
})
