import { expect, test } from 'bun:test'
import { RECORD_WRITE_SPACE_REMEDY } from '../../shared/record-remedies.ts'
import { hostedRequestHandler } from './hosted.ts'
import { HOSTED_WRITE_ROUTES } from './hosted-write-routes.ts'

const identityFetch = (async (_input: string | URL | Request, _init?: RequestInit) =>
  Response.json({
    user: { id: 'user-a', name: 'A' },
    activeSpaceId: 'space-a',
    memberships: [
      {
        space_id: 'space-a',
        name: 'Space A',
        slug: 'space-a',
        role: 'owner',
        permission: 'write',
      },
    ],
  })) as unknown as typeof fetch

const handler = hostedRequestHandler(
  {
    recordApiUrl: 'https://api.example.test',
    recordDatabaseUrl: {} as never,
    noDestinationWriteCounter: {
      record: async () => undefined,
      read: async () => ({ windowStart: '', unrecorded: 0, counts: [] }),
    },
  },
  {
    changes: { fetch: identityFetch, push: async () => [] },
    tasks: { fetch: identityFetch },
    notes: { fetch: identityFetch },
    waitingEmail: {
      fetch: identityFetch,
      send: async () => ({ id: 'message', status: 'sent' as const, reason: null }),
    },
    reports: {
      fetch: identityFetch,
      unsubscribeEmailRecipient: async () => true,
    },
  },
)

test('every hosted write route behavior matches its destination classification', async () => {
  const keys = new Set<string>()
  for (const route of HOSTED_WRITE_ROUTES) {
    const key = `${route.method} ${route.path}`
    expect(keys.has(key)).toBe(false)
    keys.add(key)
    expect(route.destination, key).toBeDefined()
    if (route.destination === 'exempt') expect(route.reason?.length).toBeGreaterThan(0)

    const response = await handler(
      new Request(`https://hub.example.test${route.example}`, {
        method: route.method,
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: '{}',
      }),
    )
    const body = (await response.json().catch(() => null)) as {
      error?: string
      remedy?: string
    } | null
    if (route.destination === 'required') {
      expect(response.status, key).toBe(409)
      expect(body, key).toEqual({
        error: 'write request names no destination space',
        remedy: RECORD_WRITE_SPACE_REMEDY,
      })
    } else {
      expect(response.status, key).not.toBe(409)
      expect(response.status, key).not.toBe(404)
    }
  }
})

test('an unregistered hosted write route is refused before dispatch', async () => {
  const response = await handler(
    new Request('https://hub.example.test/v1/not-in-the-registry', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: '{}',
    }),
  )

  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({
    error: 'write route is not in the hosted write registry',
    remedy: 'add it to HOSTED_WRITE_ROUTES in hub/src/hosted-write-routes.ts',
  })
})
