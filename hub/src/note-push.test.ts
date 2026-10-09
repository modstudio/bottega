import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { writeTransaction } from './db.ts'
import { pushNotes } from './note-push.ts'

beforeEach(resetFixtureStore)

test('note push sends each space only that space projects notes', async () => {
  const at = '2026-10-09T12:00:00.000Z'
  writeTransaction((conn) => {
    const insert = conn.query(`INSERT INTO note
      (record_id,number,project,text,anchors,sightings,created_at,last_seen_at)
      VALUES (?,?,?,?,'[]',1,?,?)`)
    insert.run('01990000-0000-7000-8000-000000000501', 1, 'workshop', 'active note', at, at)
    insert.run('01990000-0000-7000-8000-000000000502', 1, 'gamma', 'gamma note', at, at)
    conn.query(`INSERT INTO note_counter(project,next) VALUES ('workshop',2),('gamma',2)`).run()
  })
  const mirrors: Array<{ space: string | null; projects: string[] }> = []
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    if (url.pathname === '/v1/tasks/identity')
      return Response.json({
        userId: 'user-1',
        activeSpaceId: 'space-a',
        memberships: [
          { spaceId: 'space-a', slug: 'active' },
          { spaceId: 'space-gamma', slug: 'declared-gamma-space' },
        ],
        capabilities: { projectNoteCounters: true, targetSpaceNotes: true },
      })
    const space = new Headers(init?.headers).get('x-record-space')
    if (url.pathname === '/v1/notes/counts')
      return Response.json({ note: 1, note_acknowledgement: 0 })
    const body = JSON.parse(String(init?.body)) as { notes?: Array<{ project: string }> }
    if (body.notes?.length)
      mirrors.push({ space, projects: body.notes.map((note) => note.project) })
    return Response.json({ upserted: body.notes?.length ?? 0, noteIds: [] })
  }

  await expect(
    pushNotes({ baseUrl: 'https://hub.example.test', token: 'session', fetch }),
  ).resolves.toMatchObject({ match: true })
  expect(mirrors).toEqual([
    { space: 'space-a', projects: ['workshop'] },
    { space: 'space-gamma', projects: ['gamma'] },
  ])
})
