import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from '../../../shared/config-directory.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import {
  installRecordSessionRunner,
  memoryRecordSession,
} from '../../test/fixtures/record-session.ts'
import {
  recordApiBaseUrl,
  recordApiClient,
  recordApiSignIn,
  recordAuthRefusal,
  recordAuthToken,
  recordIdentityResponse,
  recordInvitationListResponse,
} from './record-api-client.ts'
import { classifyBoardStreamResponse } from './record-api-client-board-stream.ts'

describe('record HTTP authentication responses', () => {
  test('sign-in posts without an Origin and prefers the bearer response header', async () => {
    const previousUrl = process.env.BOTTEGA_RECORD_API_URL
    const originalFetch = globalThis.fetch
    process.env.BOTTEGA_RECORD_API_URL = 'https://api.example.test'
    const requests: Array<{ url: string; headers: Headers; body: unknown }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      })
      return Response.json(
        { token: 'body-token', user: { id: 'user-a', email: 'a@example.test' } },
        { headers: { 'set-auth-token': 'header-token' } },
      )
    }) as typeof fetch
    try {
      expect(await recordApiSignIn('a@example.test', 'secret')).toEqual({
        token: 'header-token',
        user: { id: 'user-a', email: 'a@example.test' },
      })
      expect(requests[0]).toEqual({
        url: 'https://api.example.test/api/auth/sign-in/email',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: { email: 'a@example.test', password: 'secret' },
      })
      expect(requests[0]?.headers.has('origin')).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      if (previousUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
      else process.env.BOTTEGA_RECORD_API_URL = previousUrl
    }
  })

  test('takes the bearer token from the response header before the JSON fallback', () => {
    expect(
      recordAuthToken(new Headers({ 'set-auth-token': 'header-token' }), { token: 'body-token' }),
    ).toBe('header-token')
    expect(recordAuthToken(new Headers(), { token: 'body-token' })).toBe('body-token')
    expect(recordAuthToken(new Headers(), {})).toBeNull()
  })

  test('maps credential and rate-limit refusals to actionable messages', () => {
    expect(recordAuthRefusal(401, {}, new Headers()).message).toContain(
      'record credentials were refused',
    )
    expect(recordAuthRefusal(429, {}, new Headers({ 'retry-after': '12' })).message).toBe(
      'record sign-in is rate limited; retry after 12',
    )
    expect(recordAuthRefusal(503, { error: 'maintenance' }, new Headers())).toMatchObject({
      kind: 'server',
      status: 503,
      message: `record API 503: maintenance\ncleared by: ${PLATFORM_SLUG} record doctor`,
    })
  })

  test('validates and maps whoami identity at the HTTP edge', () => {
    const mapped = recordIdentityResponse({
      user: { id: 'user-a', email: 'a@example.test' },
      activeSpaceId: 'space-b',
      personalSpaceId: 'space-a',
      memberships: [
        {
          space_id: 'space-b',
          name: 'Beta',
          slug: 'beta',
          role: 'member',
          permission: 'write',
        },
      ],
    })
    expect(mapped.memberships.map((row) => row.space_id)).toEqual(['space-b'])
    expect(() => recordIdentityResponse({ user: {}, memberships: [] })).toThrow('invalid identity')
  })

  test('validates the invitation fields printed by the command', () => {
    const invitation = {
      id: 'invitation-a',
      spaceName: 'Alpha',
      spaceSlug: 'alpha',
      role: 'member',
      inviterEmail: 'owner@example.test',
      expiresAt: '2026-10-20T12:00:00.000Z',
    }
    expect(recordInvitationListResponse([invitation])).toEqual([invitation])
    expect(() => recordInvitationListResponse([{ ...invitation, spaceSlug: null }])).toThrow(
      'invalid invitation list',
    )
  })
})

test('the record API base URL resolves from configured files', () => {
  const root = mkdtempSync(join(tmpdir(), 'record-api-client-url-'))
  try {
    const config = join(root, 'config')
    const harness = join(root, 'harness.env')
    mkdirSync(config)
    writeFileSync(harness, 'BOTTEGA_RECORD_API_URL=https://file.example.test/\n')

    expect(
      recordApiBaseUrl({
        NODE_ENV: 'development',
        [CONFIG_HOME_ENV]: config,
        [HARNESS_ENV_FILE_ENV]: harness,
      }),
    ).toBe('https://file.example.test')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('record API client test safety', () => {
  test('sync preserves the active-space remedy from a client refusal', async () => {
    const session = memoryRecordSession()
    session.setToken('sync-token')
    installRecordSessionRunner(session.runner)
    installRecordApiClient(null)
    const previousEnv = process.env.NODE_ENV
    const previousUrl = process.env.BOTTEGA_RECORD_API_URL
    process.env.NODE_ENV = 'development'
    process.env.BOTTEGA_RECORD_API_URL = 'https://api.example.test'
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      Response.json(
        {
          error: `record session has no active space; run \`${PLATFORM_SLUG} record space switch <slug>\``,
        },
        { status: 409 },
      )) as unknown as typeof fetch
    try {
      let refusal: unknown
      try {
        await recordApiClient().sync!({
          machine: { id: newRecordId(), name: 'fixture', seenAt: '2026-10-13T12:00:00.000Z' },
          rows: [],
        })
      } catch (error) {
        refusal = error
      }
      expect(refusal).toBeInstanceOf(Error)
      expect((refusal as Error).message).toBe(
        `record session has no active space; run \`${PLATFORM_SLUG} record space switch <slug>\``,
      )
    } finally {
      globalThis.fetch = originalFetch
      process.env.NODE_ENV = previousEnv
      if (previousUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
      else process.env.BOTTEGA_RECORD_API_URL = previousUrl
      installRecordApiClient(createMemoryRecordApiClient())
    }
  })

  test('refuses a real base URL unless a stub is injected', () => {
    installRecordApiClient(null)
    const previous = process.env.BOTTEGA_RECORD_API_URL
    const previousContainer = process.env.BOTTEGA_TEST_POSTGRES_CONTAINER
    process.env.BOTTEGA_RECORD_API_URL = 'https://api.example.test'
    delete process.env.BOTTEGA_TEST_POSTGRES_CONTAINER
    try {
      expect(() => recordApiClient()).toThrow(
        'record API client refuses a real base URL unless a stub is injected in tests',
      )
    } finally {
      if (previous === undefined) delete process.env.BOTTEGA_RECORD_API_URL
      else process.env.BOTTEGA_RECORD_API_URL = previous
      if (previousContainer === undefined) delete process.env.BOTTEGA_TEST_POSTGRES_CONTAINER
      else process.env.BOTTEGA_TEST_POSTGRES_CONTAINER = previousContainer
      installRecordApiClient(createMemoryRecordApiClient())
    }
  })

  test('public document methods send neither authorization nor cookies', async () => {
    installRecordSessionRunner(null)
    installRecordApiClient(null)
    const previousEnv = process.env.NODE_ENV
    const previousUrl = process.env.BOTTEGA_RECORD_API_URL
    process.env.NODE_ENV = 'development'
    process.env.BOTTEGA_RECORD_API_URL = 'https://api.example.test'
    const calls: Array<{ url: string; headers: Headers; credentials?: RequestCredentials }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        credentials: init?.credentials,
      })
      return Response.json({ items: [] })
    }) as typeof fetch
    try {
      const client = recordApiClient()
      const id = newRecordId()
      await client.listPublicDocs()
      await client.getPublicDoc(id)
      await client.searchPublicDocs('public guide')
      expect(calls.map((call) => call.url)).toEqual([
        'https://api.example.test/public/v1/docs',
        `https://api.example.test/public/v1/docs/${id}`,
        'https://api.example.test/public/v1/docs/search?q=public+guide',
      ])
      for (const call of calls) {
        expect(call.credentials).toBe('omit')
        expect(call.headers.has('authorization')).toBe(false)
        expect(call.headers.has('cookie')).toBe(false)
      }
    } finally {
      globalThis.fetch = originalFetch
      process.env.NODE_ENV = previousEnv
      if (previousUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
      else process.env.BOTTEGA_RECORD_API_URL = previousUrl
      installRecordApiClient(createMemoryRecordApiClient())
    }
  })

  test('destination-aware project and id-addressed document calls send x-record-space', async () => {
    const session = memoryRecordSession()
    session.setToken('destination-token')
    installRecordSessionRunner(session.runner)
    installRecordApiClient(null)
    const previousEnv = process.env.NODE_ENV
    const previousUrl = process.env.BOTTEGA_RECORD_API_URL
    process.env.NODE_ENV = 'development'
    process.env.BOTTEGA_RECORD_API_URL = 'https://api.example.test'
    const calls: Headers[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Headers(init?.headers))
      return Response.json({ id: newRecordId(), revisionId: newRecordId(), name: 'known' })
    }) as typeof fetch
    try {
      const client = recordApiClient()
      const destination = { destinationSpaceId: 'stable-space-id' }
      await client.upsertProject(
        {
          id: '01990000-0000-7000-8000-000000000001',
          name: 'known',
          path: '/repo/known',
          stack: null,
          canon: false,
          settings: {},
          retiredAt: null,
        },
        destination,
      )
      await client.deleteDoc(newRecordId(), { reason: 'test', author: 'tester' }, destination)
      expect(calls.map((headers) => headers.get('x-record-space'))).toEqual([
        'stable-space-id',
        'stable-space-id',
      ])
    } finally {
      globalThis.fetch = originalFetch
      process.env.NODE_ENV = previousEnv
      if (previousUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
      else process.env.BOTTEGA_RECORD_API_URL = previousUrl
      installRecordApiClient(createMemoryRecordApiClient())
    }
  })

  test('reorderDocs puts the order at the hosted document order route', async () => {
    const session = memoryRecordSession()
    session.setToken('order-token')
    installRecordSessionRunner(session.runner)
    installRecordApiClient(null)
    const previousEnv = process.env.NODE_ENV
    const previousUrl = process.env.BOTTEGA_RECORD_API_URL
    process.env.NODE_ENV = 'development'
    process.env.BOTTEGA_RECORD_API_URL = 'https://api.example.test'
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return Response.json({ orderedIds: [] })
    }) as typeof fetch
    try {
      const order = { scope: 'project', subject: 'Product', parentId: null, orderedIds: [] }
      await recordApiClient().reorderDocs(order)
      expect(calls).toEqual([
        {
          url: 'https://api.example.test/v1/docs/order',
          method: 'PUT',
          body: order,
        },
      ])
    } finally {
      globalThis.fetch = originalFetch
      process.env.NODE_ENV = previousEnv
      if (previousUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
      else process.env.BOTTEGA_RECORD_API_URL = previousUrl
      installRecordSessionRunner(null)
      installRecordApiClient(createMemoryRecordApiClient())
    }
  })

  test('board methods use the ruled paths and map a non-success body', async () => {
    const session = memoryRecordSession()
    session.setToken('board-token')
    installRecordSessionRunner(session.runner)
    installRecordApiClient(null)
    const previousEnv = process.env.NODE_ENV
    const previousUrl = process.env.BOTTEGA_RECORD_API_URL
    process.env.NODE_ENV = 'development'
    process.env.BOTTEGA_RECORD_API_URL = 'https://api.example.test'
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return Response.json({ error: 'nope' }, { status: 409 })
    }) as typeof fetch
    try {
      const client = recordApiClient()
      const id = newRecordId()
      await expect(
        client.listBoardMessages({ kind: 'question', open: true, includeEnded: false }),
      ).rejects.toThrow(/nope/)
      await expect(client.getBoardThread(id)).rejects.toThrow(/nope/)
      await expect(client.getBoardStatus(id)).rejects.toThrow(/nope/)
      await expect(
        client.postBoardMessage({
          id,
          kind: 'notice',
          audience: 'operator',
          title: 'T',
          body: 'B',
          expiresAt: '2026-10-06T00:00:00.000Z',
        }),
      ).rejects.toMatchObject({ message: 'nope', kind: 'refused', status: 409 })
      await expect(
        client.replyBoardMessage(id, {
          id: newRecordId(),
          body: 'Directed reply',
          audience: { kind: 'session', sessionId: 'in-reach' },
        }),
      ).rejects.toMatchObject({ message: 'nope', kind: 'refused', status: 409 })
      expect(calls[0]).toMatchObject({
        url: 'https://api.example.test/v1/board/messages?kind=question&open=true&includeEnded=false',
        method: 'GET',
      })
      expect(calls[1]).toMatchObject({
        url: `https://api.example.test/v1/board/threads/${id}`,
        method: 'GET',
      })
      expect(calls[2]).toMatchObject({
        url: `https://api.example.test/v1/board/messages/${id}/status`,
        method: 'GET',
      })
      expect(calls[3]).toMatchObject({
        url: 'https://api.example.test/v1/board/messages',
        method: 'PUT',
        body: { id, kind: 'notice', audience: 'operator', title: 'T', body: 'B' },
      })
      const posted = calls[3]?.body as Record<string, unknown>
      expect(posted).not.toHaveProperty('recipientUserIds')
      expect(posted).not.toHaveProperty('claimId')
      expect(calls[4]).toMatchObject({
        url: `https://api.example.test/v1/board/messages/${id}/replies`,
        method: 'POST',
        body: { body: 'Directed reply', audience: 'session:in-reach' },
      })
    } finally {
      globalThis.fetch = originalFetch
      process.env.NODE_ENV = previousEnv
      if (previousUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
      else process.env.BOTTEGA_RECORD_API_URL = previousUrl
      installRecordSessionRunner(null)
      installRecordApiClient(createMemoryRecordApiClient())
    }
  })

  test('board rate limits preserve the server remedy', async () => {
    const session = memoryRecordSession()
    session.setToken('board-token')
    installRecordSessionRunner(session.runner)
    installRecordApiClient(null)
    const previousEnv = process.env.NODE_ENV
    const previousUrl = process.env.BOTTEGA_RECORD_API_URL
    process.env.NODE_ENV = 'development'
    process.env.BOTTEGA_RECORD_API_URL = 'https://api.example.test'
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(
        { error: 'board post rate limit reached; retry after the ten-minute author window' },
        { status: 429 },
      )) as typeof fetch
    try {
      await expect(
        recordApiClient().postBoardMessage({
          id: newRecordId(),
          kind: 'notice',
          audience: 'operator',
          title: 'T',
          body: 'B',
          expiresAt: '2026-10-06T00:00:00.000Z',
        }),
      ).rejects.toThrow('board post rate limit reached; retry after the ten-minute author window')
    } finally {
      globalThis.fetch = originalFetch
      process.env.NODE_ENV = previousEnv
      if (previousUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
      else process.env.BOTTEGA_RECORD_API_URL = previousUrl
      installRecordSessionRunner(null)
      installRecordApiClient(createMemoryRecordApiClient())
    }
  })

  test('board server errors report the reached status and body with the doctor remedy', async () => {
    const session = memoryRecordSession()
    session.setToken('board-token')
    installRecordSessionRunner(session.runner)
    installRecordApiClient(null)
    const previousEnv = process.env.NODE_ENV
    const previousUrl = process.env.BOTTEGA_RECORD_API_URL
    process.env.NODE_ENV = 'development'
    process.env.BOTTEGA_RECORD_API_URL = 'https://api.example.test'
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      Response.json({ error: 'claim write failed' }, { status: 500 })) as unknown as typeof fetch
    try {
      await expect(
        recordApiClient().takeBoardClaim({
          id: newRecordId(),
          project: PLATFORM_SLUG,
          projectId: newRecordId(),
          subject: 'task:DEV-1638',
        }),
      ).rejects.toMatchObject({
        kind: 'server',
        status: 500,
        message: `record API 500: claim write failed\ncleared by: ${PLATFORM_SLUG} record doctor`,
      })
    } finally {
      globalThis.fetch = originalFetch
      process.env.NODE_ENV = previousEnv
      if (previousUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
      else process.env.BOTTEGA_RECORD_API_URL = previousUrl
      installRecordSessionRunner(null)
      installRecordApiClient(createMemoryRecordApiClient())
    }
  })

  test('openBoardStream releases a refused or bodiless response', async () => {
    const session = memoryRecordSession()
    session.setToken('stream-token')
    installRecordSessionRunner(session.runner)
    installRecordApiClient(null)
    const previousEnv = process.env.NODE_ENV
    const previousUrl = process.env.BOTTEGA_RECORD_API_URL
    process.env.NODE_ENV = 'development'
    process.env.BOTTEGA_RECORD_API_URL = 'https://api.example.test'
    const originalFetch = globalThis.fetch
    const stub = (status: number, withBody: boolean) => {
      let cancelled = false
      let aborted = false
      const body = withBody
        ? new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true
            },
          })
        : null
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true
        })
        return { status, body } as Response
      }) as unknown as typeof fetch
      return {
        cancelled: () => cancelled,
        aborted: () => aborted,
      }
    }
    try {
      const unauthorized = stub(401, true)
      expect(await recordApiClient().openBoardStream()).toEqual({ kind: 'unauthorized' })
      expect(unauthorized.cancelled()).toBe(true)
      expect(unauthorized.aborted()).toBe(true)
      const error = stub(500, true)
      expect(await recordApiClient().openBoardStream()).toEqual({
        kind: 'error',
        reason: 'record API 500',
      })
      expect(error.cancelled()).toBe(true)
      expect(error.aborted()).toBe(true)
      const missing = stub(200, false)
      expect(await recordApiClient().openBoardStream()).toEqual({
        kind: 'error',
        reason: 'record API 200',
      })
      expect(missing.cancelled()).toBe(false)
      expect(missing.aborted()).toBe(true)
      const parent = new AbortController()
      parent.abort()
      let fetched = false
      globalThis.fetch = (async () => {
        fetched = true
        return new Response('nope')
      }) as unknown as typeof fetch
      expect(await recordApiClient().openBoardStream(parent.signal)).toEqual({
        kind: 'error',
        reason: 'aborted',
      })
      expect(fetched).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      process.env.NODE_ENV = previousEnv
      if (previousUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
      else process.env.BOTTEGA_RECORD_API_URL = previousUrl
      installRecordSessionRunner(null)
      installRecordApiClient(createMemoryRecordApiClient())
    }
  })

  test('openBoardStream classifies 200, 401, 403, 500, and a thrown fetch', async () => {
    const session = memoryRecordSession()
    session.setToken('stream-token')
    installRecordSessionRunner(session.runner)
    installRecordApiClient(null)
    const previousEnv = process.env.NODE_ENV
    const previousUrl = process.env.BOTTEGA_RECORD_API_URL
    process.env.NODE_ENV = 'development'
    process.env.BOTTEGA_RECORD_API_URL = 'https://api.example.test'
    const originalFetch = globalThis.fetch
    const run = async (status: number | 'throw') => {
      globalThis.fetch = (async () => {
        if (status === 'throw') throw new Error('connect reset')
        return new Response(': heartbeat\n\n', {
          status,
          headers: { 'content-type': 'text/event-stream' },
        })
      }) as unknown as typeof fetch
      return await recordApiClient().openBoardStream()
    }
    try {
      const ok = await run(200)
      expect(ok.kind).toBe('stream')
      if (ok.kind === 'stream') {
        const chunk = await ok.source.read()
        expect(new TextDecoder().decode(chunk ?? new Uint8Array())).toBe(': heartbeat\n\n')
        ok.close()
      }
      expect(await run(401)).toEqual({ kind: 'unauthorized' })
      expect(await run(403)).toEqual({ kind: 'unauthorized' })
      expect(await run(500)).toEqual({ kind: 'error', reason: 'record API 500' })
      expect(await run('throw')).toEqual({ kind: 'error', reason: 'connect reset' })
    } finally {
      globalThis.fetch = originalFetch
      process.env.NODE_ENV = previousEnv
      if (previousUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
      else process.env.BOTTEGA_RECORD_API_URL = previousUrl
      installRecordSessionRunner(null)
      installRecordApiClient(createMemoryRecordApiClient())
    }
  })
})

test('classifyBoardStreamResponse maps status without the board module', () => {
  const close = () => undefined
  const body = new Response('ok').body
  expect(classifyBoardStreamResponse(200, body, close).kind).toBe('stream')
  expect(classifyBoardStreamResponse(401, body, close)).toEqual({ kind: 'unauthorized' })
  expect(classifyBoardStreamResponse(403, body, close)).toEqual({ kind: 'unauthorized' })
  expect(classifyBoardStreamResponse(500, body, close)).toEqual({
    kind: 'error',
    reason: 'record API 500',
  })
})
