import { beforeAll, describe, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { assertMirrorExpectedSpace, confirmCount, mirrorCollisionDecision } from './hosted-tasks.ts'
import { createTask } from './task.ts'
import { taskApi } from './task-api.ts'
import { applyHostedTaskChanges } from './task-cache.ts'
import {
  hostedCreateTask,
  hostedDeleteTasks,
  hostedTaskIdentity,
  hostedTaskPresence,
} from './task-client.ts'
import { closeThenPrune } from './task-close.ts'

beforeAll(resetFixtureStore)

describe('hosted-only task safety', () => {
  test('mirror expected-space checks name both spaces and accept older clients', () => {
    expect(() => assertMirrorExpectedSpace(undefined, 'space-b')).not.toThrow()
    expect(() => assertMirrorExpectedSpace('space-b', 'space-b')).not.toThrow()
    expect(() => assertMirrorExpectedSpace('space-a', 'space-b')).toThrow(
      'mirror expected space space-a, actual space space-b; re-run after the active space settles',
    )
  })

  test('a mismatched mirror request reaches no write service', async () => {
    let writes = 0
    const response = await taskApi(
      new Request('https://hub.example.test/v1/tasks/mirror', {
        method: 'PUT',
        headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
        body: JSON.stringify({ tasks: [], expectedSpaceId: 'space-a' }),
      }),
      { recordApiUrl: 'https://record.example.test', recordDatabaseUrl: 'postgres://unused' },
      {
        fetch: async () =>
          Response.json({ user: { id: 'user-1' }, activeSpaceId: 'space-b', memberships: [] }),
        mirror: async () => {
          writes++
          return { upserted: 0, adoptions: [] }
        },
      },
    )

    expect(response?.status).toBe(409)
    expect(await response?.json()).toEqual({
      error:
        'mirror expected space space-a, actual space space-b; re-run after the active space settles',
    })
    expect(writes).toBe(0)
  })

  test('mirror collision decisions insert, update, deduplicate events, and refuse reused ids', () => {
    const incoming = { id: 'id-1', spaceId: 'space-a', naturalKey: 'task DEV-1' }
    expect(mirrorCollisionDecision(incoming, null, 'update')).toEqual({ action: 'insert' })
    expect(
      mirrorCollisionDecision(incoming, null, 'update', 'natural-key', null, false, {
        id: 'id-2',
        spaceId: 'space-a',
        naturalKey: 'task DEV-1',
      }),
    ).toEqual({
      action: 'refuse',
      reason:
        "refusing to mirror task DEV-1 with id id-1: task DEV-1 in space space-a already belongs to id id-2; restore this local row's record id to id-2, change the task key in that space, or ask the hosted-space operator to resolve the task key collision",
    })
    expect(
      mirrorCollisionDecision(incoming, null, 'update', 'natural-key', null, true, {
        id: 'id-2',
        spaceId: 'space-a',
        naturalKey: 'task DEV-1',
      }),
    ).toEqual({ action: 'adopt', id: 'id-2' })
    expect(
      mirrorCollisionDecision(incoming, null, 'update', 'natural-key', null, true, {
        id: 'id-2',
        spaceId: 'space-b',
        naturalKey: 'task DEV-1',
      }),
    ).toMatchObject({ action: 'refuse' })
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
    expect(
      mirrorCollisionDecision(
        { id: 'id-1', spaceId: 'space-a', naturalKey: 'comment 760' },
        null,
        'update',
        'id',
        { id: 'id-2', spaceId: 'space-a', legacyLocalId: 760 },
        true,
      ),
    ).toEqual({ action: 'adopt', id: 'id-2' })
    expect(
      mirrorCollisionDecision(
        { id: 'id-1', spaceId: 'space-a', naturalKey: 'document 760' },
        null,
        'update',
        'id',
        { id: 'id-2', spaceId: 'space-b', legacyLocalId: 760 },
        true,
      ),
    ).toEqual({
      action: 'refuse',
      reason:
        "refusing to mirror document 760 with id id-1: legacy local id 760 in space space-b already belongs to id id-2; restore this local row's record id to id-2, or ask the hosted-space operator to resolve the local id collision",
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
        { id: 'pushed-id', spaceId: 'space-a', naturalKey: 'status event DEV-1/open/at' },
        null,
        'idempotent',
        'status-event',
        null,
        false,
        {
          id: 'collector-id',
          spaceId: 'space-a',
          naturalKey: 'status event DEV-1/open/at',
        },
      ),
    ).toEqual({ action: 'adopt', id: 'collector-id' })
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
    ).toEqual({ action: 'update-same-row' })
    expect(
      mirrorCollisionDecision(
        incoming,
        { id: 'id-1', spaceId: 'space-a', naturalKey: 'task OPS-12' },
        'update',
        'natural-key',
        null,
        false,
        { id: 'id-2', spaceId: 'space-a', naturalKey: 'task DEV-1' },
      ),
    ).toEqual({
      action: 'refuse',
      reason:
        "refusing to mirror task DEV-1 with id id-1: task DEV-1 in space space-a already belongs to id id-2; restore this local row's record id to id-2, change the task key in that space, or ask the hosted-space operator to resolve the task key collision",
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
    ).rejects.toThrow('hosted hub is unreachable')
    expect(db().query<{ count: number }, []>(`SELECT count(*) count FROM task`).get()!.count).toBe(
      before,
    )
  })

  test('close never prunes after a hosted close failure', async () => {
    let pruned = false
    await expect(
      closeThenPrune('DEV-1', {}, false, {
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

  test('soft deletes apply their declared confirmation policy', () => {
    expect(() => confirmCount(1, undefined, 'exact-always')).toThrow('confirmation count 1')
    expect(() => confirmCount(1, 0, 'exact-always')).toThrow('confirmation count 1')
    expect(() => confirmCount(1, 1, 'exact-always')).not.toThrow()
    expect(() => confirmCount(1, undefined, 'bulk-only')).not.toThrow()
    expect(() => confirmCount(2, 1, 'bulk-only')).toThrow('confirmation count 2')
    expect(() => confirmCount(2, 2, 'bulk-only')).not.toThrow()
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
      userId: 'user-1',
      activeSpaceId: 'space-a',
      memberships: [
        { spaceId: 'space-a', slug: 'workshop' },
        { spaceId: 'space-b', slug: 'stopal' },
      ],
    })
  })

  test('the task API authorizes presence reads and bulk deletes through the active identity', async () => {
    const whoami = async () =>
      Response.json({
        user: { id: 'user-1' },
        activeSpaceId: 'space-a',
        memberships: [
          { space_id: 'space-a', slug: 'active' },
          { space_id: 'space-b', slug: 'other' },
        ],
      })
    const presence = await taskApi(
      new Request('https://hub.example.test/v1/tasks/presence', {
        method: 'POST',
        headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
        body: JSON.stringify({ pairs: [{ space_id: 'space-b', key: 'STO-1' }] }),
      }),
      { recordApiUrl: 'https://record.example.test', recordDatabaseUrl: 'postgres://unused' },
      {
        fetch: whoami,
        presence: async (_url, identity, pairs) => ({
          present: identity.spaceIds?.includes('space-b') ? pairs : [],
          refused: [],
        }),
      },
    )
    expect(await presence?.json()).toEqual({
      present: [{ space_id: 'space-b', key: 'STO-1' }],
      refused: [],
    })

    const deletion = await taskApi(
      new Request('https://hub.example.test/v1/tasks', {
        method: 'DELETE',
        headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
        body: JSON.stringify({ ids: ['task-1'], confirmation: 1 }),
      }),
      { recordApiUrl: 'https://record.example.test', recordDatabaseUrl: 'postgres://unused' },
      {
        fetch: whoami,
        deleteTasks: async (_url, identity, ids, confirmation) => ({
          tasks: identity.spaceId === 'space-a' && ids.length === confirmation ? 1 : 0,
          comments: 2,
          documents: 3,
          statusEvents: 4,
        }),
      },
    )
    expect(await deletion?.json()).toEqual({
      tasks: 1,
      comments: 2,
      documents: 3,
      statusEvents: 4,
    })
  })

  test('task clients carry presence pairs and bulk-delete confirmation in request bodies', async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = []
    const fetch = async (input: string, init?: RequestInit) => {
      requests.push({
        path: new URL(input).pathname,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return new URL(input).pathname.endsWith('/presence')
        ? Response.json({ present: [], refused: [] })
        : Response.json({ tasks: 1, comments: 2, documents: 3, statusEvents: 4 })
    }
    const options = { baseUrl: 'https://hub.example.test', token: 'test', fetch }
    await hostedTaskPresence([{ space_id: 'space-b', key: 'STO-1' }], options)
    await hostedDeleteTasks(['task-1'], 1, options)
    expect(requests).toEqual([
      {
        path: '/v1/tasks/presence',
        method: 'POST',
        body: { pairs: [{ space_id: 'space-b', key: 'STO-1' }] },
      },
      {
        path: '/v1/tasks',
        method: 'DELETE',
        body: { ids: ['task-1'], confirmation: 1 },
      },
    ])
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
        .query(`INSERT INTO task_document(record_id,task_key,task_record_id,title,body,version,created_at,updated_at)
        VALUES ('01990000-0000-7000-8000-000000000102','DEV-990','01990000-0000-7000-8000-000000000101','old','body','v1',?,?)`)
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
      comments: [
        {
          id: '01990000-0000-7000-8000-000000000103',
          legacy_local_id: null,
          task_key: 'DEV-990',
          project_name: 'workshop',
          body: 'pulled',
          created_at: at,
          updated_at: at,
          deleted_at: null,
        },
      ],
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
    expect(
      db()
        .query<{ task_record_id: string }, []>(
          `SELECT task_record_id FROM task_comment WHERE task_key='DEV-990'`,
        )
        .get()?.task_record_id,
    ).toBe('01990000-0000-7000-8000-000000000101')
  })

  test('cache pull updates a task by hosted record id when its label changes', () => {
    const at = '2026-09-24T11:00:00.000Z'
    const id = '01990000-0000-7000-8000-000000000180'
    writeTransaction((conn) =>
      conn
        .query(`INSERT INTO task(record_id,key,project,title,source,first_seen,last_seen)
          VALUES (?,'DEV-980','workshop','old label','local',?,?)`)
        .run(id, at, at),
    )
    applyHostedTaskChanges({
      tasks: [
        {
          id,
          key: 'DEV-981',
          project: 'workshop',
          project_name: 'workshop',
          title: 'renamed',
          status: 'open',
          status_category: 'open',
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
        },
      ],
      comments: [],
      documents: [],
      statusEvents: [],
      cursor: at,
    })
    expect(
      db()
        .query<{ key: string; title: string }, [string]>(
          'SELECT key,title FROM task WHERE record_id=?',
        )
        .get(id),
    ).toEqual({ key: 'DEV-981', title: 'renamed' })
  })

  test('cache pull reconciles a child applied before its parent', () => {
    const at = '2026-09-24T12:00:00.000Z'
    const common = {
      project: 'workshop',
      project_name: 'workshop',
      status: 'open',
      status_category: 'open' as const,
      body: null,
      assignee: null,
      opened_at: at,
      closed_at: null,
      source: 'local' as const,
      first_seen: at,
      last_seen: at,
      created_at: at,
      updated_at: at,
      deleted_at: null,
    }
    applyHostedTaskChanges({
      tasks: [
        {
          ...common,
          id: '01990000-0000-7000-8000-000000000201',
          key: 'DEV-992',
          title: 'child first',
          parent_key: 'DEV-991',
        },
        {
          ...common,
          id: '01990000-0000-7000-8000-000000000200',
          key: 'DEV-991',
          title: 'parent second',
          parent_key: null,
        },
      ],
      comments: [],
      documents: [],
      statusEvents: [],
      cursor: at,
    })

    expect(
      db()
        .query<{ parent_record_id: string }, []>(
          "SELECT parent_record_id FROM task WHERE key='DEV-992'",
        )
        .get()?.parent_record_id,
    ).toBe('01990000-0000-7000-8000-000000000200')
  })
})
