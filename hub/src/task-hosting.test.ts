import { beforeAll, describe, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { confirmSoftDelete, mirrorCollisionDecision } from './hosted-tasks.ts'
import { createTask } from './task.ts'
import { taskApi } from './task-api.ts'
import { applyHostedTaskChanges } from './task-cache.ts'
import { hostedCreateTask, hostedTaskIdentity } from './task-client.ts'
import { closeThenPrune } from './task-close.ts'

beforeAll(resetFixtureStore)

describe('hosted-only task safety', () => {
  test('mirror collision decisions insert, update, deduplicate events, and refuse reused ids', () => {
    const incoming = { id: 'id-1', spaceId: 'space-a', naturalKey: 'task DEV-1' }
    expect(mirrorCollisionDecision(incoming, null, 'update')).toEqual({ action: 'insert' })
    expect(
      mirrorCollisionDecision(
        { id: 'id-1', spaceId: 'space-a', naturalKey: 'comment 760' },
        null,
        'update',
        'id',
        { id: 'id-2', spaceId: 'space-a', legacyLocalId: 760 },
      ),
    ).toEqual({
      action: 'refuse',
      reason:
        "refusing to mirror comment 760 with id id-1: legacy local id 760 in space space-a already belongs to id id-2; restore this local row's record id to id-2, or ask the hosted-space operator to resolve the local id collision",
    })
    expect(mirrorCollisionDecision(incoming, incoming, 'update')).toEqual({
      action: 'update-same-row',
    })
    expect(mirrorCollisionDecision(incoming, incoming, 'idempotent')).toEqual({
      action: 'idempotent-duplicate',
    })
    expect(
      mirrorCollisionDecision(
        { id: 'id-1', spaceId: 'space-a', naturalKey: 'comment 760' },
        { id: 'id-1', spaceId: 'space-a', naturalKey: 'comment with no local id' },
        'update',
        'id',
      ),
    ).toEqual({ action: 'update-same-row' })
    expect(
      mirrorCollisionDecision(
        { id: 'id-1', spaceId: 'space-a', naturalKey: 'status event 42' },
        { id: 'id-1', spaceId: 'space-a', naturalKey: 'status event with no local id' },
        'idempotent',
        'id',
      ),
    ).toEqual({ action: 'idempotent-duplicate' })
    expect(
      mirrorCollisionDecision(
        { id: 'id-1', spaceId: 'space-b', naturalKey: 'document 12' },
        { id: 'id-1', spaceId: 'space-a', naturalKey: 'document with no local id' },
        'update',
        'id',
      ),
    ).toEqual({
      action: 'refuse',
      reason:
        "refusing to mirror document 12: id id-1 already belongs to document with no local id in space space-a; restore this local row's record id to the id for document 12, or ask the hosted-space operator to resolve the id collision",
    })
    expect(
      mirrorCollisionDecision(
        incoming,
        { id: 'id-1', spaceId: 'space-a', naturalKey: 'task OPS-12' },
        'update',
      ),
    ).toEqual({
      action: 'refuse',
      reason:
        "refusing to mirror task DEV-1: id id-1 already belongs to task OPS-12 in space space-a; restore this local row's record id to the id for task DEV-1, or ask the hosted-space operator to resolve the id collision",
    })
    expect(
      mirrorCollisionDecision(
        incoming,
        { id: 'id-1', spaceId: 'space-b', naturalKey: 'task OPS-12' },
        'update',
      ),
    ).toEqual({
      action: 'refuse',
      reason:
        "refusing to mirror task DEV-1: id id-1 already belongs to task OPS-12 in space space-b; restore this local row's record id to the id for task DEV-1, or ask the hosted-space operator to resolve the id collision",
    })
  })

  test('an unreachable hosted write refuses and leaves the cache unchanged', async () => {
    const before = db().query<{ count: number }, []>(`SELECT count(*) count FROM task`).get()!.count
    await expect(
      createTask(
        { project: 'workshop', title: 'Must not enter the cache' },
        {
          hosted: {
            baseUrl: 'https://hub.example.test',
            token: 'test',
            fetch: async () => {
              throw new Error('offline')
            },
          },
        },
      ),
    ).rejects.toThrow('HUB_HOSTED_URL')
    expect(db().query<{ count: number }, []>(`SELECT count(*) count FROM task`).get()!.count).toBe(
      before,
    )
  })

  test('close never prunes after a hosted close failure', async () => {
    let pruned = false
    await expect(
      closeThenPrune('DEV-1', false, {
        close: async () => {
          throw new Error('hosted close failed')
        },
        prune: async (project, key) => {
          pruned = true
          return {
            project,
            key,
            dryRun: false,
            deleted: [],
            kept: [],
            operator: [],
            wouldDelete: [],
            errors: [],
          }
        },
      }),
    ).rejects.toThrow('hosted close failed')
    expect(pruned).toBeFalse()
  })

  test('multi-row soft deletes require the exact confirmation count', () => {
    expect(() => confirmSoftDelete(2)).toThrow('confirmation count 2')
    expect(() => confirmSoftDelete(2, 1)).toThrow('confirmation count 2')
    expect(() => confirmSoftDelete(2, 2)).not.toThrow()
  })

  test('the task API refuses real dependencies under the test runner', async () => {
    await expect(
      taskApi(
        new Request('https://hub.example.test/v1/tasks', {
          headers: { authorization: 'Bearer test' },
        }),
        {
          recordApiUrl: 'https://record.example.test',
          recordDatabaseUrl: 'postgres://real',
        },
      ),
    ).rejects.toThrow('unless stubs are injected')
  })

  test('the task identity route returns the active space and membership slugs', async () => {
    const response = await taskApi(
      new Request('https://hub.example.test/v1/tasks/identity', {
        headers: { authorization: 'Bearer test' },
      }),
      {
        recordApiUrl: 'https://record.example.test',
        recordDatabaseUrl: 'postgres://unused',
      },
      {
        fetch: async () =>
          Response.json({
            user: { id: 'user-1' },
            activeSpaceId: 'space-a',
            memberships: [
              { space_id: 'space-a', slug: 'workshop' },
              { space_id: 'space-b', slug: 'stopal' },
            ],
          }),
      },
    )

    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({
      activeSpaceId: 'space-a',
      memberships: [
        { spaceId: 'space-a', slug: 'workshop' },
        { spaceId: 'space-b', slug: 'stopal' },
      ],
    })
  })

  test('hosted refusals preserve server errors and remedies without suggesting local configuration', async () => {
    const options = {
      baseUrl: 'https://hub.example.test',
      token: 'test',
      fetch: async () =>
        Response.json(
          { error: 'task not found', remedy: 'Create the task in the active space.' },
          { status: 404 },
        ),
    }

    await expect(hostedCreateTask({}, options)).rejects.toThrow(
      'hosted hub refused the request (404): task not found. Create the task in the active space.',
    )
  })

  test('a missing hosted task identity route requires redeployment', async () => {
    await expect(
      hostedTaskIdentity({
        baseUrl: 'https://hub.example.test',
        token: 'test',
        fetch: async () => Response.json({ error: 'route not found' }, { status: 404 }),
      }),
    ).rejects.toThrow(
      'hosted hub does not serve the task identity route (404): route not found; redeploy the hosted hub from this revision',
    )
  })

  test('cache pull applies an update and a soft delete', () => {
    const at = '2026-09-17T12:00:00.000Z'
    writeTransaction((conn) => {
      conn
        .query(`INSERT INTO task(record_id,key,project,title,status,status_category,source,first_seen,last_seen)
        VALUES ('01990000-0000-7000-8000-000000000101','DEV-990','workshop','old','open','open','local',?,?)`)
        .run(at, at)
      conn
        .query(`INSERT INTO task_document(record_id,task_key,title,body,version,created_at,updated_at)
        VALUES ('01990000-0000-7000-8000-000000000102','DEV-990','old','body','v1',?,?)`)
        .run(at, at)
    })
    applyHostedTaskChanges({
      tasks: [
        {
          id: '01990000-0000-7000-8000-000000000101',
          key: 'DEV-990',
          project: 'workshop',
          project_name: 'workshop',
          title: 'new',
          status: 'active',
          status_category: 'active',
          parent_key: null,
          body: null,
          assignee: null,
          opened_at: at,
          closed_at: null,
          source: 'local',
          first_seen: at,
          last_seen: at,
          created_at: at,
          updated_at: '2026-09-17T12:01:00.000Z',
          deleted_at: null,
        },
      ],
      comments: [],
      statusEvents: [],
      documents: [
        {
          id: '01990000-0000-7000-8000-000000000102',
          legacy_local_id: null,
          task_key: 'DEV-990',
          project_name: 'workshop',
          role: null,
          title: 'old',
          body: 'body',
          version: 'v1',
          created_at: at,
          updated_at: '2026-09-17T12:01:00.000Z',
          deleted_at: '2026-09-17T12:01:00.000Z',
        },
      ],
      cursor: '2026-09-17T12:01:00.000Z',
    })
    expect(
      db().query<{ title: string }, []>(`SELECT title FROM task WHERE key='DEV-990'`).get()?.title,
    ).toBe('new')
    expect(
      db()
        .query<{ count: number }, []>(
          `SELECT count(*) count FROM task_document WHERE task_key='DEV-990'`,
        )
        .get()?.count,
    ).toBe(0)
  })
})
