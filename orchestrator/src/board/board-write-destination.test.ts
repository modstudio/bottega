import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { fixtureProjectRecordId } from '../database/test-database.fixture.ts'
import type { RecordApiClient } from '../record/record-api-client.ts'
import { refreshHostedBoard } from './board-hosted-cache.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'
import { boardPresenceDestination, boardWriteDestination } from './board-write-destination.ts'

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

test('a board write resolves a declared project and refuses unknown or unauthorized projects', async () => {
  const projectId = fixtureProjectRecordId(db())
  db()
    .query('UPDATE project SET name=?,settings=? WHERE record_id=?')
    .run('destination-project', JSON.stringify({ space: 'project-space' }), projectId)
  const client = {
    ...createMemoryRecordApiClient(),
    whoami: async () => ({
      user: { id: 'user-a', email: 'architect@example.test' },
      activeSpaceId: null,
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
  expect(await boardWriteDestination(client, 'destination-project')).toEqual({
    destinationSpaceId: 'project-space',
  })
  await expect(boardWriteDestination(client, 'unregistered-project')).rejects.toThrow(
    'has no declared record space',
  )

  const unauthorizedClient = {
    ...client,
    whoami: async () => ({
      user: { id: 'user-a', email: 'architect@example.test' },
      activeSpaceId: null,
      personalSpaceId: 'personal-space',
      memberships: [
        {
          space_id: 'personal-space',
          name: 'Personal',
          slug: 'personal',
          role: 'owner',
          permission: 'write',
        },
      ],
    }),
  }
  await expect(boardWriteDestination(unauthorizedClient, 'destination-project')).rejects.toThrow(
    'not a member',
  )
})

test('refresh sends only the checkout projects presence and none outside a project', async () => {
  const now = Date.parse('2026-10-05T12:00:00.000Z')
  const projectId = fixtureProjectRecordId(db())
  const otherProjectId = newRecordId()
  db().query('UPDATE project SET path=? WHERE record_id=?').run(process.cwd(), projectId)
  db()
    .query('INSERT INTO project(record_id,name,path,canon,settings) VALUES (?,?,?,?,?)')
    .run(otherProjectId, 'other-presence-project', '/other/project', 0, '{}')
  db()
    .query('INSERT OR REPLACE INTO schema_meta(key,value) VALUES (?,?)')
    .run(BOARD_HOSTED_ADOPTED_KEY, '1')
  db()
    .query(
      `INSERT OR REPLACE INTO presence
       (session_id,harness,role,machine,project,project_record_id,cwd,first_seen,last_seen)
       VALUES ('presence-destination','claude','architect','machine',?,?,'/tmp',?,?),
              ('other-presence','claude','architect','machine','other-presence-project',?,'/tmp',?,?)`,
    )
    .run(
      PLATFORM_SLUG,
      projectId,
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      otherProjectId,
      new Date(now).toISOString(),
      new Date(now).toISOString(),
    )
  let resolved = 0
  let sent: string | undefined
  const sentPresence: string[][] = []
  const client = {
    ...createMemoryRecordApiClient(),
    listBoardChanges: async (
      query: Parameters<RecordApiClient['listBoardChanges']>[0],
      destination?: Parameters<RecordApiClient['listBoardChanges']>[1],
    ) => {
      sent = destination?.destinationSpaceId
      sentPresence.push((query.presence ?? []).map((row) => row.session))
      return { userId: 'user-a', items: [], highestRevision: null }
    },
  }
  const result = await refreshHostedBoard({
    budgetMs: 1_000,
    client,
    database: db(),
    env: { BOTTEGA_RECORD_API_URL: 'https://record.test' },
    now: () => now,
    cwd: process.cwd(),
    presenceDestinationResolver: async () => {
      resolved++
      return { destinationSpaceId: 'presence-space' }
    },
  })
  expect(result.status).toBe('success')
  expect({ resolved, sent, sentPresence }).toEqual({
    resolved: 1,
    sent: 'presence-space',
    sentPresence: [['presence-destination']],
  })

  await refreshHostedBoard({
    budgetMs: 1_000,
    client,
    database: db(),
    env: { BOTTEGA_RECORD_API_URL: 'https://record.test' },
    now: () => now,
    cwd: '/outside/registered/projects',
    presenceDestinationResolver: async () => {
      resolved++
      return { destinationSpaceId: 'unexpected' }
    },
  })
  expect(resolved).toBe(1)
  expect(sentPresence.at(-1)).toEqual([])
})
