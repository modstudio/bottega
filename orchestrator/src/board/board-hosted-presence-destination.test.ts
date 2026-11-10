import { expect, test } from 'bun:test'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { fixtureProjectRecordId } from '../database/test-database.fixture.ts'
import { boardPresenceDestination } from './board-hosted-presence-destination.ts'

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
