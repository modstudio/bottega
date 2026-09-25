import { beforeAll, describe, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { noteMirrorCollision } from './hosted-notes.ts'
import { confirmCount } from './hosted-tasks.ts'
import { createNote, getNote, promoteNote } from './note.ts'
import { applyHostedNoteChanges } from './note-cache.ts'
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
  test('number seeding never goes below an existing number', () => {
    expect(nextNoteNumber(140n, 3n)).toBe(141n)
    expect(nextNoteNumber(140n, 200n)).toBe(200n)
  })

  test('a push against a hosted note of the same number with a different record_id is refused', () => {
    const incoming = { id: 'id-new', number: 12, spaceId: 'space-a' }
    const existing = { id: 'id-hosted', spaceId: 'space-a' }
    const decision = noteMirrorCollision(incoming, null, existing)
    expect(decision.action).toBe('refuse')
    if (decision.action !== 'refuse') throw new Error('expected refusal')
    expect(decision.reason).toContain('note 12')
    expect(decision.reason).toContain('id-hosted')
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
    const id = Number(
      writeTransaction(
        (conn) =>
          conn
            .query(`INSERT INTO note(project,text,anchors,sightings,created_at,last_seen_at)
      VALUES ('workshop','promotion failure','[]',1,?,?)`)
            .run(at, at).lastInsertRowid,
      ),
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
    const row = (number: number, text: string, deleted_at: string | null) => ({
      id: crypto.randomUUID(),
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
      acknowledgements: [],
      cursor: at,
    })
    applyHostedNoteChanges({
      notes: [row(990, 'new', null), row(991, 'gone', at)],
      acknowledgements: [],
      cursor: at,
    })
    expect(getNote(990).text).toBe('new')
    expect(() => getNote(991)).toThrow('no note 991')
  })
})
