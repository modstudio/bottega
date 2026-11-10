import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { fixtureProjectRecordId } from '../database/test-database.fixture.ts'
import { refreshHostedBoard } from './board-hosted-cache.ts'
import { boardPresenceDestination } from './board-hosted-presence-destination.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'

test('presence names the checkout project space or the personal space outside a project', async () => {
  const projectId = fixtureProjectRecordId(db())
  db()
    .query('UPDATE project SET path=?,settings=? WHERE record_id=?')
    .run(process.cwd(), JSON.stringify({ space: 'project-space' }), projectId)
  const client = {
    ...createMemoryRecordApiClient(),
    whoami: async () => ({
      user: { id: 'user-a', email: 'architect@example.test' },
      activeSpaceId: 'personal-space',
      personalSpaceId: 'personal-space',
      memberships: [
        {
          space_id: 'personal-space',
          name: 'Personal',
          slug: 'personal',
          role: 'owner',
          permission: 'write',
        },
        {
          space_id: 'project-space',
          name: 'Project',
          slug: 'project',
          role: 'member',
          permission: 'write',
        },
      ],
    }),
  }
  expect(await boardPresenceDestination(client, process.cwd())).toEqual({
    destinationSpaceId: 'project-space',
  })
  expect(await boardPresenceDestination(client, '/outside/registered/projects')).toEqual({
    destinationSpaceId: 'personal-space',
  })
})

test('an injected refresh client still resolves and sends the presence destination', async () => {
  const now = Date.parse('2026-10-05T12:00:00.000Z')
  const projectId = fixtureProjectRecordId(db())
  db()
    .query('INSERT OR REPLACE INTO schema_meta(key,value) VALUES (?,?)')
    .run(BOARD_HOSTED_ADOPTED_KEY, '1')
  db()
    .query(
      `INSERT OR REPLACE INTO presence
       (session_id,harness,role,machine,project,project_record_id,cwd,first_seen,last_seen)
       VALUES ('presence-destination','claude','architect','machine',?,?,'/tmp',?,?)`,
    )
    .run(PLATFORM_SLUG, projectId, new Date(now).toISOString(), new Date(now).toISOString())
  let resolved = 0
  let sent: string | undefined
  const client = {
    ...createMemoryRecordApiClient(),
    listBoardChanges: async (_query: unknown, destination?: { destinationSpaceId?: string }) => {
      sent = destination?.destinationSpaceId
      return { userId: 'user-a', items: [], highestRevision: null }
    },
  }
  const result = await refreshHostedBoard({
    budgetMs: 1_000,
    client,
    database: db(),
    env: { BOTTEGA_RECORD_API_URL: 'https://record.test' },
    now: () => now,
    presenceDestination: async () => {
      resolved++
      return { destinationSpaceId: 'presence-space' }
    },
  })
  expect(result.status).toBe('success')
  expect({ resolved, sent }).toEqual({ resolved: 1, sent: 'presence-space' })
})
