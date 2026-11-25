import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { hostedRouteTestConfig } from '../test/hosted-route-fixture.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { noteMirrorCollision } from './hosted-notes.ts'
import { HostedOutsideNoteError } from './hosted-outside-notes.ts'
import { confirmCount } from './hosted-tasks.ts'
import { createNote, promoteNote } from './note.ts'
import { noteApi } from './note-api.ts'
import { applyHostedNoteRows } from './note-cache.ts'
import { hostedNoteChanges, hostedReapNotes } from './note-client.ts'
import { nextNoteNumber } from './note-number.ts'
import { getNote } from './note-read.ts'
import { showTask } from './task.ts'

const applyHostedNoteChanges = (changes: Awaited<ReturnType<typeof hostedNoteChanges>>) =>
  writeTransaction((conn) => applyHostedNoteRows(conn, changes))

beforeAll(resetFixtureStore)
afterAll(resetFixtureStore)
const unreachable = {
  baseUrl: 'https://hub.example.test',
  token: 'test',
  fetch: async () => {
    throw new Error('offline')
  },
}

describe('hosted-only note safety', () => {
  test('the outside route preserves a service refusal status', async () => {
    const status = 429
    const message = 'outside write limit reached'
    const response = await noteApi(
      new Request('https://hub.example.test/v1/notes/outside', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ project: 'outside', text: 'note', anchor: '{}' }),
      }),
      hostedRouteTestConfig,
      {
        fetch: (async () =>
          Response.json({
            user: { id: 'user-1' },
            activeSpaceId: 'space-a',
            memberships: [],
          })) as unknown as typeof fetch,
        outsideCreate: async () => {
          throw new HostedOutsideNoteError(message, status)
        },
      },
    )
    expect(response?.status).toBe(status)
    expect(await response?.json()).toEqual({ error: message })
  })

  test('the promote route passes the caller title to the promotion', async () => {
    const id = '01990000-0000-7000-8000-000000000001'
    let promotedInput: unknown
    const response = await noteApi(
      new Request(`https://hub.example.test/v1/notes/${id}/promote`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test',
          'content-type': 'application/json',
          'x-record-space': 'space-a',
        },
        body: JSON.stringify({ title: 'The point of the note' }),
      }),
      hostedRouteTestConfig,
      {
        fetch: (async () =>
          Response.json({
            user: { id: 'user-1' },
            activeSpaceId: 'space-a',
            memberships: [{ space_id: 'space-a', slug: 'active', permission: 'write' }],
          })) as unknown as typeof fetch,
        promote: async (...args: unknown[]) => {
          promotedInput = args[3]
          return null
        },
      },
    )

    expect(response?.status).toBe(404)
    expect(promotedInput).toEqual({ task: undefined, title: 'The point of the note' })
  })

  test('the slim list route forwards every query filter', async () => {
    let captured: unknown
    const response = await noteApi(
      new Request(
        'https://hub.example.test/v1/notes/list?project=gamma&kept=true&session=a&session=b&text=x&promoted_to=DEV-7&reference=gamma%231&limit=3',
        {
          headers: { authorization: 'Bearer test', 'x-record-space': 'space-a' },
        },
      ),
      hostedRouteTestConfig,
      {
        fetch: (async () =>
          Response.json({
            user: { id: 'user-1' },
            activeSpaceId: 'space-a',
            memberships: [{ space_id: 'space-a', slug: 'active', permission: 'write' }],
          })) as unknown as typeof fetch,
        listSlim: async (...args: unknown[]) => {
          captured = args[2]
          return { notes: [], total: 0 }
        },
      },
    )

    expect(response?.status).toBe(200)
    expect(captured).toEqual({
      project: 'gamma',
      stale: undefined,
      actionable: false,
      promotedTo: 'DEV-7',
      reference: 'gamma#1',
      sessions: ['a', 'b'],
      kept: true,
      text: 'x',
      limit: 3,
    })
  })

  test('the candidate route requires and forwards project and text', async () => {
    let captured: unknown[] = []
    const identity = (async () =>
      Response.json({
        user: { id: 'user-1' },
        activeSpaceId: 'space-a',
        memberships: [{ space_id: 'space-a', slug: 'active', permission: 'write' }],
      })) as unknown as typeof fetch
    const response = await noteApi(
      new Request('https://hub.example.test/v1/notes/candidates?project=gamma&text=alpha%20beta', {
        headers: { authorization: 'Bearer test', 'x-record-space': 'space-a' },
      }),
      hostedRouteTestConfig,
      {
        fetch: identity,
        listCandidates: async (...args: unknown[]) => {
          captured = args.slice(2)
          return []
        },
      },
    )
    expect(response?.status).toBe(200)
    expect(captured).toEqual(['gamma', 'alpha beta'])

    const refused = await noteApi(
      new Request('https://hub.example.test/v1/notes/candidates?project=gamma', {
        headers: { authorization: 'Bearer test', 'x-record-space': 'space-a' },
      }),
      hostedRouteTestConfig,
      { fetch: identity },
    )
    expect(refused?.status).toBe(400)
  })

  test('the slim list route refuses an invalid limit as caller input', async () => {
    for (const limit of ['abc', '0', '-1', '']) {
      const response = await noteApi(
        new Request(`https://hub.example.test/v1/notes/list?limit=${limit}`, {
          headers: { authorization: 'Bearer test', 'x-record-space': 'space-a' },
        }),
        hostedRouteTestConfig,
        {
          fetch: (async () =>
            Response.json({
              user: { id: 'user-1' },
              activeSpaceId: 'space-a',
              memberships: [{ space_id: 'space-a', slug: 'active', permission: 'write' }],
            })) as unknown as typeof fetch,
        },
      )

      expect(response?.status, `limit=${limit}`).toBe(400)
      expect(await response?.json()).toEqual({
        error: 'limit must be a positive integer; omit it to list every matching note',
      })
    }
  })

  test('the slim list route refuses state filters with promoted-to or reference', async () => {
    const identity = (async () =>
      Response.json({
        user: { id: 'user-1' },
        activeSpaceId: 'space-a',
        memberships: [{ space_id: 'space-a', slug: 'active', permission: 'write' }],
      })) as unknown as typeof fetch
    for (const [query, error] of [
      ['promoted_to=DEV-7&stale=true', 'promoted_to cannot be combined with stale=true'],
      ['promoted_to=DEV-7&actionable=true', 'promoted_to cannot be combined with actionable=true'],
      ['reference=gamma%231&stale=true', 'reference cannot be combined with stale=true'],
      ['reference=gamma%231&actionable=true', 'reference cannot be combined with actionable=true'],
    ]) {
      const response = await noteApi(
        new Request(`https://hub.example.test/v1/notes/list?${query}`, {
          headers: { authorization: 'Bearer test', 'x-record-space': 'space-a' },
        }),
        hostedRouteTestConfig,
        { fetch: identity },
      )
      expect(response?.status, query).toBe(400)
      expect(await response?.json()).toEqual({ error })
    }

    let captured: unknown
    const accepted = await noteApi(
      new Request(
        'https://hub.example.test/v1/notes/list?promoted_to=DEV-7&stale=false&actionable=false',
        {
          headers: { authorization: 'Bearer test', 'x-record-space': 'space-a' },
        },
      ),
      hostedRouteTestConfig,
      {
        fetch: identity,
        listSlim: async (...args: unknown[]) => {
          captured = args[2]
          return { notes: [], total: 0 }
        },
      },
    )
    expect(accepted?.status).toBe(200)
    expect(captured).toMatchObject({ promotedTo: 'DEV-7', stale: false, actionable: false })
  })

  test('every note route refuses a requested space outside the caller memberships', async () => {
    const id = '01990000-0000-7000-8000-000000000001'
    const routes = [
      ['GET', '/v1/notes'],
      ['GET', '/v1/notes/list'],
      ['GET', '/v1/notes/candidates?project=gamma&text=note'],
      ['GET', '/v1/notes/counts'],
      ['GET', `/v1/notes/${id}`],
      ['POST', '/v1/notes'],
      ['POST', `/v1/notes/${id}/promote`],
      ['POST', '/v1/notes/reap'],
      ['PUT', '/v1/notes/mirror'],
    ] as const
    for (const [method, path] of routes) {
      const response = await noteApi(
        new Request(`https://hub.example.test${path}`, {
          method,
          headers: {
            authorization: 'Bearer test',
            'content-type': 'application/json',
            'x-record-space': 'missing',
          },
          ...(method === 'GET' ? {} : { body: '{}' }),
        }),
        hostedRouteTestConfig,
        {
          fetch: (async () =>
            Response.json({
              user: { id: 'user-1' },
              activeSpaceId: 'space-a',
              memberships: [{ space_id: 'space-a', slug: 'active', permission: 'write' }],
            })) as unknown as typeof fetch,
        },
      )
      expect(response?.status, `${method} ${path}`).toBe(403)
    }
  })

  test('note changes refuse a server without project counter support', async () => {
    await expect(
      hostedNoteChanges(null, {
        baseUrl: 'https://hub.example.test',
        token: 'test',
        fetch: async (input) => {
          if (new URL(input).pathname === '/v1/tasks/identity')
            return Response.json({
              userId: 'user-1',
              activeSpaceId: 'space-a',
              memberships: [],
              capabilities: {},
            })
          return Response.json({ error: 'unexpected route' }, { status: 500 })
        },
      }),
    ).rejects.toThrow('deploy the hub server at or after the per-project note counter change')
  })

  test('number seeding never goes below an existing number', () => {
    expect(nextNoteNumber(140n, 3n)).toBe(141n)
    expect(nextNoteNumber(140n, 200n)).toBe(200n)
  })

  test('a push against a hosted note of the same number with a different record_id is refused', () => {
    const incoming = { id: 'id-new', number: 12, project: 'workshop', spaceId: 'space-a' }
    const existing = { id: 'id-hosted', spaceId: 'space-a' }
    const decision = noteMirrorCollision(incoming, null, existing)
    expect(decision.action).toBe('refuse')
    if (decision.action !== 'refuse') throw new Error('expected refusal')
    expect(decision.reason).toContain('workshop#12')
    expect(decision.reason).toContain('id-hosted')
    expect(decision.reason).toContain('id-new')
    expect(decision.reason).toContain(`${PLATFORM_SLUG} note list`)
    expect(noteMirrorCollision(incoming, incoming, incoming)).toEqual({ action: 'update-same-row' })
    expect(noteMirrorCollision(incoming, null, null)).toEqual({ action: 'insert' })
  })

  test('reap refuses a confirmation count mismatch', () => {
    expect(() => confirmCount(2, 1, 'bulk-only')).toThrow('confirmation count 2')
  })

  test('reap API refuses an old payload before writing', async () => {
    let writes = 0
    const response = await noteApi(
      new Request('https://hub.example.test/v1/notes/reap', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test',
          'content-type': 'application/json',
          'x-record-space': 'space-a',
        },
        body: JSON.stringify({
          stale: [],
          deleted: [],
          confirmation: 0,
          cutoff: new Date().toISOString(),
        }),
      }),
      hostedRouteTestConfig,
      {
        fetch: (async () =>
          Response.json({
            user: { id: 'user-1' },
            activeSpaceId: 'space-a',
            memberships: [{ space_id: 'space-a', slug: 'active', permission: 'write' }],
          })) as unknown as typeof fetch,
        reap: async () => {
          writes += 1
          return {}
        },
      },
    )
    expect(response?.status).toBe(400)
    expect(await response?.json()).toEqual({
      error: expect.stringContaining(`${PLATFORM_SLUG} machine update`),
    })
    expect(writes).toBe(0)
  })

  test('reap refuses an older hosted API before posting maintenance', async () => {
    const paths: string[] = []
    await expect(
      hostedReapNotes(
        { stale: [], annotated: [], restored: [], deleted: [], confirmation: 0, cutoff: '' },
        {
          baseUrl: 'https://hub.example.test',
          token: 'test',
          recordSpace: 'space-a',
          fetch: async (input) => {
            paths.push(new URL(input).pathname)
            return Response.json({
              userId: 'user-1',
              activeSpaceId: 'space-a',
              memberships: [],
              capabilities: {},
            })
          },
        },
      ),
    ).rejects.toThrow('scripts/deploy/hosted api')
    expect(paths).toEqual(['/v1/tasks/identity'])
  })
  test('an unreachable hosted write refuses and leaves the cache unchanged', async () => {
    const before = db().query<{ count: number }, []>('SELECT count(*) count FROM note').get()!.count
    await expect(
      createNote(
        { text: 'Must not enter cache', cwd: '/fixtures/repos/workshop', forceNew: true },
        { hosted: unreachable },
      ),
    ).rejects.toThrow(
      'the hosted record at https://hub.example.test could not be reached (offline); nothing was written',
    )
    expect(db().query<{ count: number }, []>('SELECT count(*) count FROM note').get()!.count).toBe(
      before,
    )
  })

  test('a promotion failure leaves no local task and no promoted_task', async () => {
    const at = new Date().toISOString()
    const id = crypto.randomUUID()
    writeTransaction((conn) =>
      conn
        .query(`INSERT INTO note(record_id,number,project,text,anchors,sightings,created_at,last_seen_at)
          VALUES (?,989,'workshop','promotion failure','[]',1,?,?)`)
        .run(id, at, at),
    )
    const before = db().query<{ count: number }, []>('SELECT count(*) count FROM task').get()!.count
    await expect(
      promoteNote(id, { hosted: unreachable, title: 'Promotion failure' }),
    ).rejects.toThrow(
      'the hosted record at https://hub.example.test could not be reached (offline); nothing was written',
    )
    expect(db().query<{ count: number }, []>('SELECT count(*) count FROM task').get()!.count).toBe(
      before,
    )
    expect((await getNote(id, { baseUrl: '' })).promoted_task).toBeNull()
  })

  test('cache pull applies an update and a soft delete', async () => {
    const at = '2026-09-17T12:00:00.000Z'
    const ids = new Map<number, string>()
    const row = (number: number, text: string, deletedAt: string | null) => ({
      id:
        ids.get(number) ??
        (() => {
          const id = crypto.randomUUID()
          ids.set(number, id)
          return id
        })(),
      number,
      project: 'workshop',
      project_name: 'workshop',
      text,
      area: null,
      anchors: '[]',
      sightings: 1,
      created_at: at,
      last_seen_at: at,
      stale_at: null,
      stale_reason: null,
      promoted_task: null,
      updated_at: at,
      deleted_at: deletedAt,
    })
    applyHostedNoteChanges({
      notes: [row(990, 'old', null), row(991, 'gone', null)],
      acknowledgements: [
        {
          id: crypto.randomUUID(),
          note_id: ids.get(990)!,
          project_name: 'workshop',
          session_id: 'pulled-session',
          acknowledged_at: at,
          sightings: 1,
          created_at: at,
          updated_at: at,
          deleted_at: null,
        },
      ],
      projectCounters: [{ project: 'workshop', next: 1_000 }],
      cursor: at,
    })
    applyHostedNoteChanges({
      notes: [row(990, 'new', null), row(991, 'gone', at)],
      acknowledgements: [],
      projectCounters: [{ project: 'workshop', next: 900 }],
      cursor: at,
    })
    expect((await getNote(ids.get(990)!, { baseUrl: '' })).text).toBe('new')
    expect(
      db()
        .query<{ note_record_id: string }, []>(
          `SELECT note_record_id FROM note_acknowledgement WHERE session_id='pulled-session'`,
        )
        .get(),
    ).toEqual({ note_record_id: ids.get(990)! })
    await expect(getNote(ids.get(991)!, { baseUrl: '' })).rejects.toThrow(
      `no note ${ids.get(991)!}`,
    )
    expect(
      db()
        .query<{ next: number }, []>("SELECT next FROM note_counter WHERE project='workshop'")
        .get(),
    ).toEqual({ next: 1_000 })
  })

  test('cache pull refuses a project-number collision under another UUID', () => {
    const at = '2026-09-17T12:00:00.000Z'
    const existing = crypto.randomUUID()
    writeTransaction((conn) =>
      conn
        .query(`INSERT INTO note(record_id,number,project,text,anchors,created_at,last_seen_at)
          VALUES (?,77,'workshop','existing','[]',?,?)`)
        .run(existing, at, at),
    )
    const incoming = crypto.randomUUID()
    expect(() =>
      applyHostedNoteChanges({
        notes: [
          {
            id: incoming,
            number: 77,
            project: 'workshop',
            project_name: 'workshop',
            text: 'incoming',
            area: null,
            anchors: '[]',
            sightings: 1,
            created_at: at,
            last_seen_at: at,
            stale_at: null,
            stale_reason: null,
            promoted_task: null,
            updated_at: at,
            deleted_at: null,
          },
        ],
        acknowledgements: [],
        projectCounters: [],
        cursor: at,
      }),
    ).toThrow(
      `note workshop#77 belongs to UUID ${existing}, not incoming UUID ${incoming}; run \`${PLATFORM_SLUG} note list\``,
    )
  })
})

describe('hosted promotion title', () => {
  const at = '2026-10-09T00:00:00.000Z'
  const taskId = '01990000-0000-7000-8000-000000000901'

  beforeEach(resetFixtureStore)

  type Seen = { path: string; body: unknown }

  /** A hosted hub whose promote route returns the task titled as given. */
  function hostedPromotionStub(note: { id: string; number: number; text: string }, title: string) {
    const seen: Seen[] = []
    const task = {
      id: taskId,
      key: 'GAM-1',
      project: 'gamma',
      project_name: 'gamma',
      title,
      status: 'open',
      status_category: 'open',
      parent_key: null,
      body: title,
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
    }
    const identity = () =>
      Response.json({
        userId: 'user-1',
        activeSpaceId: 'space-a',
        memberships: [
          { spaceId: 'space-a', slug: 'active', permission: 'write' },
          { spaceId: 'space-gamma', slug: 'declared-gamma-space', permission: 'write' },
        ],
        capabilities: {
          targetSpaceNotes: true,
          spacePush: true,
          spacePushTables: ['hub_task'],
        },
      })
    const promoted = () =>
      Response.json({
        note: {
          id: note.id,
          number: note.number,
          project: 'gamma',
          project_name: 'gamma',
          text: note.text,
          area: null,
          anchors: '[]',
          sightings: 1,
          created_at: at,
          last_seen_at: at,
          stale_at: null,
          stale_reason: null,
          promoted_task: task.key,
          updated_at: at,
          deleted_at: null,
        },
        task,
        comment: null,
      })
    const options = {
      baseUrl: 'https://hub.example.test',
      token: 'test',
      fetch: (async (input: string, init?: RequestInit) => {
        const url = new URL(input)
        const body = init?.body ? JSON.parse(String(init.body)) : null
        seen.push({
          path: url.pathname,
          body,
        })
        if (url.pathname === '/v1/tasks/identity') return identity()
        if (url.pathname === `/v1/notes/${note.id}`)
          return Response.json({
            id: note.id,
            number: note.number,
            project: 'gamma',
            project_name: 'gamma',
            text: note.text,
            area: null,
            anchors: '[]',
            sightings: 1,
            created_at: at,
            last_seen_at: at,
            stale_at: null,
            stale_reason: null,
            promoted_task: null,
            updated_at: at,
            deleted_at: null,
            revision: 1,
          })
        if (url.pathname.endsWith('/promote')) return promoted()
        return Response.json({ error: 'unexpected route' }, { status: 500 })
      }) as unknown as typeof fetch,
    }
    return { seen, options }
  }

  function fileGammaNote(text: string) {
    const note = { id: crypto.randomUUID(), number: 701, text }
    writeTransaction((conn) =>
      conn
        .query(`INSERT INTO note(record_id,number,project,text,anchors,sightings,created_at,last_seen_at)
          VALUES (?,?,'gamma',?,'[]',1,?,?)`)
        .run(note.id, note.number, note.text, at, at),
    )
    return note
  }

  test('a creating promotion sends its title and makes no second write', async () => {
    const note = fileGammaNote('server receives the requested title')
    const title = 'Server receives the requested title'
    const stub = hostedPromotionStub(note, title)
    const promoted = await promoteNote(note.id, { hosted: stub.options, title })

    expect(promoted.promoted_task).toBe('GAM-1')
    expect((await showTask('GAM-1', { project: 'gamma' })).task.title).toBe(title)
    expect(stub.seen.find((seen) => seen.path.endsWith('/promote'))?.body).toEqual({ title })
    expect(stub.seen.filter((seen) => seen.path === '/v1/changes')).toHaveLength(0)
  })
})
