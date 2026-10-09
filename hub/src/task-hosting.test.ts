import { beforeAll, describe, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import {
  confirmCount,
  createHostedTaskInTransaction,
  mirrorCollisionDecision,
} from './hosted-tasks.ts'
import { createTask } from './task.ts'
import { taskApi } from './task-api.ts'
import { applyHostedTaskChanges } from './task-cache.ts'
import {
  hostedCloseTask,
  hostedCommentTask,
  hostedCreateDocument,
  hostedCreateTask,
  hostedDeleteDocument,
  hostedDeleteTasks,
  hostedPatchDocument,
  hostedPatchTask,
  hostedTaskIdentity,
  hostedTaskPresence,
} from './task-client.ts'
import { closeThenPrune } from './task-close.ts'

beforeAll(resetFixtureStore)

describe('hosted-only task safety', () => {
  test('task writes bind a requested member space and keep membership scope unchanged', async () => {
    let received: Record<string, unknown> | null = null
    const response = await taskApi(
      new Request('https://hub.example.test/v1/tasks', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test',
          'content-type': 'application/json',
          'x-record-space': 'declared',
        },
        body: JSON.stringify({ project: 'workshop', title: 'Bound write' }),
      }),
      { recordApiUrl: 'https://record.example.test', recordDatabaseUrl: 'postgres://unused' },
      {
        fetch: async () =>
          Response.json({
            user: { id: 'user-1' },
            activeSpaceId: 'space-a',
            memberships: [
              { space_id: 'space-a', slug: 'active' },
              { space_id: 'space-b', slug: 'declared' },
            ],
          }),
        create: async (_url, identity) => {
          received = identity as unknown as Record<string, unknown>
          return { id: 'task-1' } as never
        },
      },
    )

    expect(response?.status).toBe(201)
    expect(received).toMatchObject({
      userId: 'user-1',
      spaceId: 'space-b',
      spaceIds: ['space-a', 'space-b'],
      memberships: [
        { spaceId: 'space-a', slug: 'active' },
        { spaceId: 'space-b', slug: 'declared' },
      ],
    })
  })

  test('task writes refuse a non-member or empty requested space before calling the writer', async () => {
    for (const requested of ['missing', '']) {
      let writes = 0
      const response = await taskApi(
        new Request('https://hub.example.test/v1/tasks', {
          method: 'POST',
          headers: {
            authorization: 'Bearer test',
            'content-type': 'application/json',
            'x-record-space': requested,
          },
          body: JSON.stringify({ project: 'workshop', title: 'Refused write' }),
        }),
        { recordApiUrl: 'https://record.example.test', recordDatabaseUrl: 'postgres://unused' },
        {
          fetch: async () =>
            Response.json({
              user: { id: 'user-1' },
              activeSpaceId: 'space-a',
              memberships: [{ space_id: 'space-a', slug: 'active' }],
            }),
          create: async () => {
            writes++
            return { id: 'task-1' } as never
          },
        },
      )

      expect(response?.status).toBe(403)
      expect(await response?.json()).toEqual({
        error: `record space '${requested}' is not among the caller's memberships`,
        remedy: 'Run `orch record space list` and choose a space where the caller is a member.',
      })
      expect(writes).toBe(0)
    }
  })

  test('a task write without a requested space keeps the active space', async () => {
    let boundSpace = ''
    await taskApi(
      new Request('https://hub.example.test/v1/tasks', {
        method: 'POST',
        headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
        body: JSON.stringify({ project: 'workshop', title: 'Active write' }),
      }),
      { recordApiUrl: 'https://record.example.test', recordDatabaseUrl: 'postgres://unused' },
      {
        fetch: async () =>
          Response.json({
            user: { id: 'user-1' },
            activeSpaceId: 'space-a',
            memberships: [{ space_id: 'space-a', slug: 'active' }],
          }),
        create: async (_url, identity) => {
          boundSpace = identity.spaceId
          return { id: 'task-1' } as never
        },
      },
    )
    expect(boundSpace).toBe('space-a')
  })

  test('a non-member requested space on the changes route reaches no list service', async () => {
    let reads = 0
    const response = await taskApi(
      new Request('https://hub.example.test/v1/tasks', {
        headers: { authorization: 'Bearer test', 'x-record-space': 'not-a-member' },
      }),
      { recordApiUrl: 'https://record.example.test', recordDatabaseUrl: 'postgres://unused' },
      {
        fetch: async () =>
          Response.json({
            user: { id: 'user-1' },
            activeSpaceId: 'space-a',
            memberships: [{ space_id: 'space-a', slug: 'active' }],
          }),
        list: async (_url, _identity) => {
          reads++
          return { tasks: [], comments: [], documents: [], statusEvents: [], cursor: '' }
        },
      },
    )
    expect(response?.status).toBe(403)
    expect(reads).toBe(0)
  })

  test('task creation distinguishes an absent project from a project without a prefix', async () => {
    const identity = { userId: 'user-1', spaceId: 'space-b' }
    const transaction = (rows: unknown[]) =>
      (async () => rows) as unknown as Parameters<typeof createHostedTaskInTransaction>[0]
    await expect(
      createHostedTaskInTransaction(transaction([]), identity, {
        project: 'missing',
        title: 'Missing',
      }),
    ).rejects.toThrow(
      "project 'missing' is absent from record space space-b. Run `orch record space move-project` or declare the project's space in the register.",
    )
    await expect(
      createHostedTaskInTransaction(
        transaction([{ id: 'project-1', key_prefixes: [] }]),
        identity,
        { project: 'present', title: 'No prefix' },
      ),
    ).rejects.toThrow("project 'present' has no key prefix")
  })

  test('a non-member mirror target and injected spaceIds reach no write service', async () => {
    let writes = 0
    const response = await taskApi(
      new Request('https://hub.example.test/v1/tasks/mirror', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer test',
          'content-type': 'application/json',
          'x-record-space': 'space-z',
        },
        body: JSON.stringify({
          tasks: [],
          targetSpaceId: 'space-a',
          spaceIds: ['space-z'],
        }),
      }),
      { recordApiUrl: 'https://record.example.test', recordDatabaseUrl: 'postgres://unused' },
      {
        fetch: async () =>
          Response.json({
            user: { id: 'user-1' },
            activeSpaceId: 'space-a',
            memberships: [{ space_id: 'space-a', slug: 'active' }],
          }),
        mirror: async () => {
          writes++
          return { upserted: 0, adoptions: [] }
        },
      },
    )

    expect(response?.status).toBe(403)
    expect(await response?.json()).toEqual({
      error: "record space 'space-z' is not among the caller's memberships",
      remedy: 'Run `orch record space list` and choose a space where the caller is a member.',
    })
    expect(writes).toBe(0)
  })

  test('a member mirror target derives its tenant principal without body-supplied spaceIds', async () => {
    const principals: Array<{
      userId: string
      spaceId: string
      spaceIds?: readonly string[]
      memberships?: Array<{ spaceId: string; slug: string }>
    }> = []
    const response = await taskApi(
      new Request('https://hub.example.test/v1/tasks/mirror', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer test',
          'content-type': 'application/json',
          'x-record-space': 'space-b',
        },
        body: JSON.stringify({ tasks: [], targetSpaceId: 'space-a', spaceIds: ['space-z'] }),
      }),
      { recordApiUrl: 'https://record.example.test', recordDatabaseUrl: 'postgres://unused' },
      {
        fetch: async () =>
          Response.json({
            user: { id: 'user-1' },
            activeSpaceId: 'space-a',
            memberships: [
              { space_id: 'space-a', slug: 'active' },
              { space_id: 'space-b', slug: 'other' },
            ],
          }),
        mirror: async (_url, identity) => {
          principals.push(identity)
          return { upserted: 0, adoptions: [] }
        },
      },
    )

    expect(response?.status).toBe(200)
    expect(principals).toEqual([
      {
        userId: 'user-1',
        spaceId: 'space-b',
        spaceIds: ['space-a', 'space-b'],
        memberships: [
          { spaceId: 'space-a', slug: 'active' },
          { spaceId: 'space-b', slug: 'other' },
        ],
      },
    ])
  })

  test('a non-member counts target returns its refusal as HTTP 403', async () => {
    let reads = 0
    const response = await taskApi(
      new Request('https://hub.example.test/v1/tasks/counts', {
        headers: { authorization: 'Bearer test', 'x-record-space': 'space-z' },
      }),
      { recordApiUrl: 'https://record.example.test', recordDatabaseUrl: 'postgres://unused' },
      {
        fetch: async () =>
          Response.json({
            user: { id: 'user-1' },
            activeSpaceId: 'space-a',
            memberships: [{ space_id: 'space-a', slug: 'active' }],
          }),
        counts: async () => {
          reads++
          return { task: [], task_comment: [], task_document: [], task_status_event: [] }
        },
      },
    )

    expect(response?.status).toBe(403)
    expect(await response?.json()).toEqual({
      error: "record space 'space-z' is not among the caller's memberships",
      remedy: 'Run `orch record space list` and choose a space where the caller is a member.',
    })
    expect(reads).toBe(0)
  })

  test('mirror collision decisions insert, update, deduplicate events, and refuse reused ids', () => {
    const incoming = { id: 'id-1', spaceId: 'space-a', naturalKey: 'task DEV-1' }
    expect(mirrorCollisionDecision(incoming, null, { sameRow: 'update' })).toEqual({
      action: 'insert',
    })
    expect(
      mirrorCollisionDecision(incoming, null, {
        sameRow: 'update',
        naturalKey: {
          holder: { id: 'id-2', spaceId: 'space-a', naturalKey: 'task DEV-1' },
        },
      }),
    ).toEqual({
      action: 'refuse',
      reason:
        "refusing to mirror task DEV-1 with id id-1: task DEV-1 in space space-a already belongs to id id-2; restore this local row's record id to id-2, change the task key in that space, or ask the hosted-space operator to resolve the task key collision",
    })
    expect(
      mirrorCollisionDecision(incoming, null, {
        sameRow: 'update',
        naturalKey: {
          holder: { id: 'id-2', spaceId: 'space-a', naturalKey: 'task DEV-1' },
          mayAdopt: true,
        },
      }),
    ).toEqual({ action: 'adopt', id: 'id-2' })
    expect(
      mirrorCollisionDecision(incoming, null, {
        sameRow: 'update',
        naturalKey: {
          holder: { id: 'id-2', spaceId: 'space-b', naturalKey: 'task DEV-1' },
          mayAdopt: true,
        },
      }),
    ).toMatchObject({ action: 'refuse' })
    expect(mirrorCollisionDecision(incoming, incoming, { sameRow: 'update' })).toEqual({
      action: 'update-same-row',
    })
    expect(mirrorCollisionDecision(incoming, incoming, { sameRow: 'idempotent' })).toEqual({
      action: 'idempotent-duplicate',
    })
    expect(
      mirrorCollisionDecision(
        { id: 'id-1', spaceId: 'space-a', naturalKey: 'incoming comment' },
        { id: 'id-1', spaceId: 'space-a', naturalKey: 'existing comment' },
        { sameRow: 'update' },
      ),
    ).toEqual({ action: 'update-same-row' })
    expect(
      mirrorCollisionDecision(
        { id: 'id-1', spaceId: 'space-a', naturalKey: 'incoming status event' },
        { id: 'id-1', spaceId: 'space-a', naturalKey: 'existing status event' },
        { sameRow: 'idempotent' },
      ),
    ).toEqual({ action: 'idempotent-duplicate' })
    expect(
      mirrorCollisionDecision(
        { id: 'pushed-id', spaceId: 'space-a', naturalKey: 'status event DEV-1/open/at' },
        null,
        {
          sameRow: 'idempotent',
          naturalKey: {
            holder: {
              id: 'collector-id',
              spaceId: 'space-a',
              naturalKey: 'status event DEV-1/open/at',
            },
          },
        },
      ),
    ).toMatchObject({ action: 'refuse' })
    expect(
      mirrorCollisionDecision(
        { id: 'id-1', spaceId: 'space-b', naturalKey: 'incoming document' },
        { id: 'id-1', spaceId: 'space-a', naturalKey: 'existing document' },
        { sameRow: 'update' },
      ),
    ).toEqual({
      action: 'refuse',
      reason:
        "refusing to mirror incoming document: id id-1 already belongs to existing document in space space-a; restore this local row's record id to the id for incoming document, or ask the hosted-space operator to resolve the id collision",
    })
    expect(
      mirrorCollisionDecision(
        incoming,
        { id: 'id-1', spaceId: 'space-a', naturalKey: 'task OPS-12' },
        { sameRow: 'update' },
      ),
    ).toEqual({ action: 'update-same-row' })
    expect(
      mirrorCollisionDecision(
        incoming,
        { id: 'id-1', spaceId: 'space-a', naturalKey: 'task OPS-12' },
        {
          sameRow: 'update',
          naturalKey: {
            holder: { id: 'id-2', spaceId: 'space-a', naturalKey: 'task DEV-1' },
          },
        },
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
        { sameRow: 'update' },
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
      closeThenPrune('DEV-1', {}, false, undefined, {
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
      capabilities: { targetSpaceTaskMirror: true, targetSpaceIntervalEvidence: true },
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

  test('every task write client sends a requested record space and omits an absent one', async () => {
    const requests: Array<{ path: string; method: string; space: string | null }> = []
    const fetch = async (input: string, init?: RequestInit) => {
      requests.push({
        path: new URL(input).pathname,
        method: init?.method ?? 'GET',
        space: new Headers(init?.headers).get('x-record-space'),
      })
      return Response.json({})
    }
    const options = {
      baseUrl: 'https://hub.example.test',
      token: 'test',
      fetch,
      recordSpace: 'declared-space',
    }
    await hostedCreateTask({}, options)
    await hostedPatchTask('DEV-1', {}, options)
    await hostedCloseTask('DEV-1', options)
    await hostedCommentTask('DEV-1', 'comment', options)
    await hostedCreateDocument('DEV-1', {}, options)
    await hostedPatchDocument('DEV-1', 'document-1', {}, options)
    await hostedDeleteDocument('DEV-1', 'document-1', options)
    await hostedCreateTask({}, { ...options, recordSpace: null })

    expect(requests).toEqual([
      { path: '/v1/tasks', method: 'POST', space: 'declared-space' },
      { path: '/v1/tasks/DEV-1', method: 'PATCH', space: 'declared-space' },
      { path: '/v1/tasks/DEV-1/close', method: 'POST', space: 'declared-space' },
      { path: '/v1/tasks/DEV-1/comments', method: 'POST', space: 'declared-space' },
      { path: '/v1/tasks/DEV-1/documents', method: 'POST', space: 'declared-space' },
      {
        path: '/v1/tasks/DEV-1/documents/document-1',
        method: 'PATCH',
        space: 'declared-space',
      },
      {
        path: '/v1/tasks/DEV-1/documents/document-1',
        method: 'DELETE',
        space: 'declared-space',
      },
      { path: '/v1/tasks', method: 'POST', space: null },
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

  test('cache pull stores child rows by record id and updates only a matching id', () => {
    const at = '2026-10-08T12:00:00.000Z'
    const taskId = '01990000-0000-7000-8000-000000000190'
    const firstId = '01990000-0000-7000-8000-000000000191'
    const secondId = '01990000-0000-7000-8000-000000000192'
    writeTransaction((conn) => {
      conn
        .query(`INSERT INTO task(record_id,key,project,source,first_seen,last_seen)
          VALUES (?,'DEV-982','workshop','local',?,?)`)
        .run(taskId, at, at)
      conn
        .query(`INSERT INTO task_comment(record_id,task_key,task_record_id,body,created_at)
          VALUES (?,'DEV-982',?,'old',?)`)
        .run(firstId, taskId, at)
    })

    applyHostedTaskChanges({
      tasks: [],
      comments: [
        {
          id: firstId,
          task_key: 'DEV-982',
          project_name: 'workshop',
          body: 'updated',
          created_at: at,
          updated_at: at,
          deleted_at: null,
        },
        {
          id: secondId,
          task_key: 'DEV-982',
          project_name: 'workshop',
          body: 'second',
          created_at: at,
          updated_at: at,
          deleted_at: null,
        },
      ],
      documents: [],
      statusEvents: [],
      cursor: at,
    })

    expect(
      db()
        .query<{ record_id: string; body: string }, []>(
          `SELECT record_id,body FROM task_comment ORDER BY record_id`,
        )
        .all()
        .filter((row) => row.record_id === firstId || row.record_id === secondId),
    ).toEqual([
      { record_id: firstId, body: 'updated' },
      { record_id: secondId, body: 'second' },
    ])
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
