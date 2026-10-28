import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { hostedRouteTestConfig } from '../test/hosted-route-fixture.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { noteMirrorCollision } from './hosted-notes.ts'
import { confirmCount } from './hosted-tasks.ts'
import { createNote, getNote, promoteNote } from './note.ts'
import { noteApi } from './note-api.ts'
import { applyHostedNoteRows } from './note-cache.ts'
import { hostedNoteChanges, hostedReapNotes } from './note-client.ts'
import { nextNoteNumber } from './note-number.ts'
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
  test('the promote route passes the caller title to the promotion', async () => {
    const id = '01990000-0000-7000-8000-000000000001'
    let promotedInput: unknown
    const response = await noteApi(
      new Request(`https://hub.example.test/v1/notes/${id}/promote`, {
        method: 'POST',
        headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
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

  test('every note route refuses a requested space outside the caller memberships', async () => {
    const id = '01990000-0000-7000-8000-000000000001'
    const routes = [
      ['GET', '/v1/notes'],
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

  test('reap refuses an older hosted API that omits maintenance counts', async () => {
    await expect(
      hostedReapNotes(
        { stale: [], annotated: [], restored: [], deleted: [], confirmation: 0, cutoff: '' },
        {
          baseUrl: 'https://hub.example.test',
          token: 'test',
          fetch: async () => Response.json({ marked: 0, deleted: 0 }),
        },
      ),
    ).rejects.toThrow('scripts/deploy/hosted api')
  })
  test('an unreachable hosted write refuses and leaves the cache unchanged', async () => {
    const before = db().query<{ count: number }, []>('SELECT count(*) count FROM note').get()!.count
    await expect(
      createNote(
        { text: 'Must not enter cache', cwd: '/fixtures/repos/workshop', forceNew: true },
        { hosted: unreachable },
      ),
    ).rejects.toThrow('hosted hub is unreachable')
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
    ).rejects.toThrow('hosted hub is unreachable')
    expect(db().query<{ count: number }, []>('SELECT count(*) count FROM task').get()!.count).toBe(
      before,
    )
    expect(getNote(id).promoted_task).toBeNull()
  })

  test('cache pull applies an update and a soft delete', () => {
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
    expect(getNote(ids.get(990)!).text).toBe('new')
    expect(
      db()
        .query<{ note_record_id: string }, []>(
          `SELECT note_record_id FROM note_acknowledgement WHERE session_id='pulled-session'`,
        )
        .get(),
    ).toEqual({ note_record_id: ids.get(990)! })
    expect(() => getNote(ids.get(991)!)).toThrow(`no note ${ids.get(991)!}`)
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
    expect(showTask('GAM-1', { project: 'gamma' }).task.title).toBe(title)
    expect(stub.seen.find((seen) => seen.path.endsWith('/promote'))?.body).toEqual({ title })
    expect(stub.seen.filter((seen) => seen.path === '/v1/changes')).toHaveLength(0)
  })
})
