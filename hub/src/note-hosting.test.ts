import { beforeAll, describe, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { noteMirrorCollision } from './hosted-notes.ts'
import { confirmCount } from './hosted-tasks.ts'
import { createNote, getNote, promoteNote } from './note.ts'
import { noteApi } from './note-api.ts'
import { applyHostedNoteChanges } from './note-cache.ts'
import { hostedDropNote, hostedNoteChanges } from './note-client.ts'
import { nextNoteNumber } from './note-number.ts'

beforeAll(resetFixtureStore)
const unreachable = {
  baseUrl: 'https://hub.example.test',
  token: 'test',
  fetch: async () => {
    throw new Error('offline')
  },
}

describe('hosted-only note safety', () => {
  test('every note route refuses a requested space outside the caller memberships', async () => {
    const id = '01990000-0000-7000-8000-000000000001'
    const routes = [
      ['GET', '/v1/notes'],
      ['GET', '/v1/notes/counts'],
      ['GET', `/v1/notes/${id}`],
      ['POST', '/v1/notes'],
      ['PATCH', `/v1/notes/${id}`],
      ['POST', `/v1/notes/${id}/acknowledgements`],
      ['POST', `/v1/notes/${id}/promote`],
      ['POST', `/v1/notes/${id}/drop`],
      ['POST', '/v1/notes/merge'],
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
        { recordApiUrl: 'https://record.example.test', recordDatabaseUrl: 'postgres://unused' },
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

  test('a note operation for another space refuses a server without target-space support', async () => {
    let noteRouteCalled = false
    await expect(
      hostedDropNote('01990000-0000-7000-8000-000000000001', 'resolved', {
        baseUrl: 'https://hub.example.test',
        token: 'test',
        recordSpace: 'space-b',
        fetch: async (input) => {
          if (new URL(input).pathname === '/v1/tasks/identity')
            return Response.json({
              userId: 'user-1',
              activeSpaceId: 'space-a',
              memberships: [
                { spaceId: 'space-a', slug: 'active', permission: 'write' },
                { spaceId: 'space-b', slug: 'target', permission: 'write' },
              ],
              capabilities: { projectNoteCounters: true },
            })
          noteRouteCalled = true
          return Response.json({ error: 'unexpected route' }, { status: 500 })
        },
      }),
    ).rejects.toThrow('deploy the hub server at or after the target-space notes change')
    expect(noteRouteCalled).toBe(false)
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
    expect(decision.reason).toContain('hub note list')
    expect(noteMirrorCollision(incoming, incoming, incoming)).toEqual({ action: 'update-same-row' })
    expect(noteMirrorCollision(incoming, null, null)).toEqual({ action: 'insert' })
  })

  test('reap refuses a confirmation count mismatch', () => {
    expect(() => confirmCount(2, 1, 'bulk-only')).toThrow('confirmation count 2')
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
    await expect(promoteNote(id, { hosted: unreachable })).rejects.toThrow(
      'hosted hub is unreachable',
    )
    expect(db().query<{ count: number }, []>('SELECT count(*) count FROM task').get()!.count).toBe(
      before,
    )
    expect(getNote(id).promoted_task).toBeNull()
  })

  test('cache pull applies an update and a soft delete', () => {
    const at = '2026-09-17T12:00:00.000Z'
    const ids = new Map<number, string>()
    const row = (number: number, text: string, deleted_at: string | null) => ({
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
      deleted_at,
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
      `note workshop#77 belongs to UUID ${existing}, not incoming UUID ${incoming}; run \`hub note list\``,
    )
  })
})
