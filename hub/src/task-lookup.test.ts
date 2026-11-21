import { expect, test } from 'bun:test'
import { hostedRouteTestConfig } from '../test/hosted-route-fixture.ts'
import { TASK_LOOKUP_KEY_LIMIT } from './hosted-tasks.ts'
import { taskApi } from './task-api.ts'
import { hostedLookupTasks } from './task-client.ts'

const whoami = async () =>
  Response.json({
    user: { id: 'user-1' },
    activeSpaceId: 'space-a',
    memberships: [{ space_id: 'space-a', slug: 'active', permission: 'read' }],
  })

const lookupRequest = (keys: string[]) =>
  new Request('https://hub.example.test/v1/tasks/lookup', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test',
      'content-type': 'application/json',
      'x-record-space': 'space-a',
    },
    body: JSON.stringify({ project: 'workshop', keys }),
  })

test('task lookup validates bounds and binds the requested tenant', async () => {
  let received: unknown = null
  const response = await taskApi(lookupRequest(['dev-1']), hostedRouteTestConfig, {
    fetch: whoami,
    lookup: async (_url, identity, project, keys) => {
      received = { space: identity.spaceId, project, keys }
      return { tasks: [] }
    },
  })
  expect(response?.status).toBe(200)
  expect(received).toEqual({ space: 'space-a', project: 'workshop', keys: ['DEV-1'] })

  const invalid = await taskApi(lookupRequest([]), hostedRouteTestConfig, { fetch: whoami })
  expect(invalid?.status).toBe(400)
  const overLimit = await taskApi(
    lookupRequest(Array.from({ length: TASK_LOOKUP_KEY_LIMIT + 1 }, (_, index) => `DEV-${index}`)),
    hostedRouteTestConfig,
    { fetch: whoami },
  )
  expect(overLimit?.status).toBe(400)
})

test('task lookup client refuses an old server with its deploy remedy', async () => {
  await expect(
    hostedLookupTasks('workshop', ['DEV-1'], {
      baseUrl: 'https://hub.example.test',
      token: 'test',
      recordSpace: 'space-a',
      fetch: async () => Response.json({ error: 'not found' }, { status: 404 }),
    }),
  ).rejects.toThrow('hosted task lookup is unavailable; run `scripts/deploy/hosted api` and retry')
})
