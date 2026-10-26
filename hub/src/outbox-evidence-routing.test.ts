import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { drainHostedOutbox } from './outbox.ts'
import { HOSTED_INTERVAL_TABLE, type HostedPushChange } from './push-contract.ts'

const oldId = '01990000-0000-7000-8000-000000008101'
const newId = '01990000-0000-7000-8000-000000008102'
const identity = {
  userId: 'user',
  activeSpaceId: 'space-active',
  memberships: [
    { spaceId: 'space-active', slug: 'active', permission: 'write' as const },
    { spaceId: 'space-old', slug: 'old', permission: 'write' as const },
    { spaceId: 'space-new', slug: 'new', permission: 'write' as const },
  ],
  capabilities: {
    spacePush: true,
    spacePushTables: [
      'hub_task' as const,
      'hub_task_status_event' as const,
      'hub_interval' as const,
      'hub_day' as const,
    ],
  },
}
const registered = () => [
  { name: 'old-project', path: '/old', repository: true, settings: { space: 'old' } },
  { name: 'new-project', path: '/new', repository: true, settings: { space: 'new' } },
]

beforeEach(resetFixtureStore)

function insert(id: string, project = 'old-project') {
  writeTransaction((conn) =>
    conn
      .query(`INSERT INTO interval
      (record_id,project,project_record_id,source,start_at,end_at,ref)
      VALUES (?,?,'project-id','orch','2026-10-11T10:00:00.000Z','2026-10-11T10:01:00.000Z','orch:move')`)
      .run(id, project),
  )
}

test('an interval move survives failure after deleting the old-space row', async () => {
  insert(oldId)
  const hosted = new Map<string, Set<string>>()
  hosted.set('space-old', new Set())
  hosted.set('space-new', new Set())
  const apply = async (changes: HostedPushChange[], options: { recordSpace: string }) => {
    for (const change of changes) {
      if (change.op === 'delete') hosted.get(options.recordSpace)?.delete(change.id)
      else hosted.get(options.recordSpace)?.add(change.id)
    }
    return changes.map(({ id }) => ({ id, status: 'applied' as const }))
  }
  await drainHostedOutbox({ identity: async () => identity, registered, push: apply })
  expect(hosted.get('space-old')).toEqual(new Set([oldId]))

  writeTransaction((conn) =>
    conn.query(`UPDATE interval SET project='new-project' WHERE record_id=?`).run(oldId),
  )
  let failNew = true
  await drainHostedOutbox({
    identity: async () => identity,
    registered,
    push: async (changes, options) => {
      if (options.recordSpace === 'space-new' && failNew) {
        failNew = false
        throw new Error('fixture failure after old delete')
      }
      return apply(changes, options)
    },
  })
  expect(hosted.get('space-old')).toEqual(new Set())
  expect(hosted.get('space-new')).toEqual(new Set())
  expect(db().query(`SELECT hosted_space_id FROM interval WHERE record_id=?`).get(oldId)).toEqual({
    hosted_space_id: null,
  })
  expect(db().query(`SELECT 1 FROM hosted_outbox`).all()).toHaveLength(1)

  await drainHostedOutbox({ identity: async () => identity, registered, push: apply })
  expect(hosted.get('space-old')).toEqual(new Set())
  expect(hosted.get('space-new')).toEqual(new Set([oldId]))
  expect(db().query(`SELECT hosted_space_id FROM interval WHERE record_id=?`).get(oldId)).toEqual({
    hosted_space_id: 'space-new',
  })
})

test('deleting an unacknowledged interval sends a duplicate delete and completes', async () => {
  insert(oldId)
  writeTransaction((conn) => conn.query(`DELETE FROM hosted_outbox`).run())
  writeTransaction((conn) => conn.query(`DELETE FROM interval WHERE record_id=?`).run(oldId))
  const sent: Array<{ space: string; change: HostedPushChange }> = []
  await drainHostedOutbox({
    identity: async () => identity,
    registered,
    push: async (changes, { recordSpace }) => {
      sent.push(...changes.map((change) => ({ space: recordSpace, change })))
      return changes.map(({ id }) => ({ id, status: 'duplicate' as const }))
    },
  })
  expect(sent).toEqual([
    { space: 'space-old', change: { table: HOSTED_INTERVAL_TABLE, id: oldId, op: 'delete' } },
  ])
  expect(db().query(`SELECT 1 FROM hosted_outbox`).all()).toHaveLength(0)
})

test('delete precedes a recreated interval with the same natural tuple', async () => {
  insert(oldId)
  writeTransaction((conn) =>
    conn.query(`UPDATE interval SET hosted_space_id='space-old' WHERE record_id=?`).run(oldId),
  )
  writeTransaction((conn) => {
    conn.query(`DELETE FROM hosted_outbox`).run()
    conn.query(`DELETE FROM interval WHERE record_id=?`).run(oldId)
    conn
      .query(`INSERT INTO interval(record_id,project,project_record_id,source,start_at,end_at,ref)
      VALUES (?,'new-project','project-id','orch','2026-10-11T10:00:00.000Z','2026-10-11T10:01:00.000Z','orch:move')`)
      .run(newId)
  })
  const order: string[] = []
  await drainHostedOutbox({
    identity: async () => identity,
    registered,
    push: async (changes, { recordSpace }) => {
      order.push(...changes.map((change) => `${recordSpace}:${change.op}:${change.id}`))
      return changes.map(({ id }) => ({ id, status: 'applied' as const }))
    },
  })
  expect(order).toEqual([`space-old:delete:${oldId}`, `space-new:upsert:${newId}`])
})

test('recreating an acknowledged interval id carries its old space into the move', async () => {
  insert(oldId)
  writeTransaction((conn) => {
    conn.query(`UPDATE interval SET hosted_space_id='space-old' WHERE record_id=?`).run(oldId)
    conn.query(`DELETE FROM hosted_outbox`).run()
    conn.query(`DELETE FROM interval WHERE record_id=?`).run(oldId)
    conn
      .query(`INSERT INTO interval(record_id,project,project_record_id,source,start_at,end_at,ref)
      VALUES (?,'new-project','project-id','orch','2026-10-11T10:00:00.000Z','2026-10-11T10:01:00.000Z','orch:move')`)
      .run(oldId)
  })
  expect(db().query(`SELECT hosted_space_id FROM interval WHERE record_id=?`).get(oldId)).toEqual({
    hosted_space_id: 'space-old',
  })
  const order: string[] = []
  await drainHostedOutbox({
    identity: async () => identity,
    registered,
    push: async (changes, { recordSpace }) => {
      order.push(...changes.map((change) => `${recordSpace}:${change.op}`))
      return changes.map(({ id }) => ({ id, status: 'applied' as const }))
    },
  })
  expect(order).toEqual(['space-old:delete', 'space-new:upsert'])
  expect(db().query(`SELECT hosted_space_id FROM interval WHERE record_id=?`).get(oldId)).toEqual({
    hosted_space_id: 'space-new',
  })
})

test('an acknowledged stale generation still records the delivered interval space', async () => {
  insert(oldId)
  await drainHostedOutbox({
    identity: async () => identity,
    registered,
    push: async (changes) => {
      writeTransaction((conn) =>
        conn.query(`UPDATE interval SET claude_tokens=1 WHERE record_id=?`).run(oldId),
      )
      return changes.map(({ id }) => ({ id, status: 'applied' as const }))
    },
  })
  expect(db().query(`SELECT hosted_space_id FROM interval WHERE record_id=?`).get(oldId)).toEqual({
    hosted_space_id: 'space-old',
  })
  expect(db().query(`SELECT attempts FROM hosted_outbox WHERE row_id=?`).get(oldId)).toEqual({
    attempts: 0,
  })
})
