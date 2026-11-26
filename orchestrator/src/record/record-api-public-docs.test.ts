import { expect, test } from 'bun:test'
import { idleRecordApiDeps, idleSubjectDeps } from '../../test/fixtures/record-api.ts'
import { recordApiTestApp } from '../../test/fixtures/record-api-app.ts'
import { identity } from './record-api-identity.fixture.ts'

test('signed doc search opts into the same readable spaces as the list', async () => {
  const listSpaces: string[][] = []
  const searchSpaces: string[][] = []
  const session = {
    ...identity,
    activeSpaceId: 'space-b',
    memberships: [
      ...identity.memberships,
      { space_id: 'space-b', name: 'Space B', slug: 'space-b' },
    ],
  }
  const app = recordApiTestApp(
    session,
    { ...idleSubjectDeps(), ...idleRecordApiDeps() },
    {
      listDocs: async (input: { spaceIds: string[] }) => {
        listSpaces.push(input.spaceIds)
        return []
      },
      searchDocs: async (input: { spaceIds: string[] }) => {
        searchSpaces.push(input.spaceIds)
        return []
      },
    },
  )

  expect((await app.request('/v1/docs?acrossReadableSpaces=true')).status).toBe(200)
  expect((await app.request('/v1/docs/search?q=writing&acrossReadableSpaces=true')).status).toBe(
    200,
  )
  expect((await app.request('/v1/docs/search?q=writing')).status).toBe(200)
  expect(listSpaces).toEqual([['space-a', 'space-b']])
  expect(searchSpaces).toEqual([['space-a', 'space-b'], ['space-b']])
})
