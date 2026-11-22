import { expect, test } from 'bun:test'
import { redactSecretShaped } from '../../shared/secret-shaped.ts'
import { hostedRouteTestConfig } from '../test/hosted-route-fixture.ts'
import { taskApi } from './task-api.ts'

test.each([
  { name: 'task create', path: '/v1/tasks', dependency: 'create' },
  {
    name: 'task document create',
    path: '/v1/tasks/DEV-2578/documents',
    dependency: 'createDocument',
  },
] as const)('$name stores fixture credentials masked', async ({ path, dependency }) => {
  const secret = 'ghp_123456789012345678901234567890123456'
  let stored = ''
  const generic = 'a key=value line with bearer prose and VGhpcyBpcyBhIGdlbmVyaWMgcHJvc2Ugc2FtcGxl'
  const input =
    dependency === 'create'
      ? { project: 'workshop', title: generic, body: `${generic} quoted ${secret}` }
      : { title: generic, body: `${generic} quoted ${secret}`, version: '1' }
  const writer = async (...args: unknown[]) => {
    const value = args.at(-1) as { body?: string; title?: string }
    stored = value.body ?? value.title ?? ''
    return { id: '01990000-0000-7000-8000-000000000201' } as never
  }
  const response = await taskApi(
    new Request(`https://hub.example.test${path}`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
        'x-record-space': 'space-a',
      },
      body: JSON.stringify(input),
    }),
    hostedRouteTestConfig,
    {
      fetch: async () =>
        Response.json({
          user: { id: 'user-1' },
          activeSpaceId: 'space-a',
          memberships: [{ space_id: 'space-a', slug: 'active', permission: 'write' }],
        }),
      [dependency]: writer,
    },
  )
  expect(response?.status).toBe(201)
  expect(stored).toBe(
    `${generic} ${redactSecretShaped(`quoted ${secret}`, { precision: 'high' }).text}`,
  )
  expect(input.title).toBe(generic)
})
