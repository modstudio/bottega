import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { createNote } from './note.ts'

beforeEach(resetFixtureStore)

test('same-as in another project space reaches the project mismatch refusal', async () => {
  const id = crypto.randomUUID()
  const at = '2026-10-09T00:00:00.000Z'
  const crossSpaceHosted = {
    baseUrl: 'https://hub.example.test',
    token: 'test',
    fetch: async (input: string, init?: RequestInit) => {
      const url = new URL(input)
      if (url.pathname === '/v1/tasks/identity')
        return Response.json({
          userId: 'user-1',
          activeSpaceId: 'space-a',
          memberships: [
            { spaceId: 'space-a', slug: 'workshop', permission: 'write' },
            { spaceId: 'space-gamma', slug: 'declared-gamma-space', permission: 'write' },
          ],
          capabilities: { targetSpaceNotes: true },
        })
      if (
        url.pathname === `/v1/notes/${id}` &&
        new Headers(init?.headers).get('x-record-space') === 'space-a'
      )
        return Response.json({
          id,
          number: 42,
          project: 'workshop',
          project_name: 'workshop',
          text: 'Existing observation',
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
      return Response.json({ error: 'note not found' }, { status: 404 })
    },
  }

  await expect(
    createNote(
      {
        text: 'Repeat in the wrong project',
        cwd: '/fixtures/repos/workshop',
        project: 'gamma',
        sameAs: id,
      },
      { hosted: crossSpaceHosted },
    ),
  ).rejects.toThrow('the matching note belongs to another project')
})
