import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from '../../../shared/config-directory.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { forgetRecordSessionToken } from '../../../shared/record-session.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import {
  installRecordSessionRunner,
  memoryRecordSession,
} from '../../test/fixtures/record-session.ts'
import { db } from '../database/db.ts'
import {
  RecordApiRequestError,
  recordApiBaseUrl,
  recordApiClient,
  recordApiRequest,
  recordApiSignIn,
  recordAuthRefusal,
  recordAuthToken,
  recordIdentityResponse,
  recordInvitationListResponse,
} from './record-api-client.ts'
import { classifyBoardStreamResponse } from './record-api-client-board-stream.ts'
import { RecordProjectSpaceConflictError } from './record-project-space-contract.ts'

describe('record HTTP authentication responses', () => {
  test('sign-in posts without an Origin and prefers the bearer response header', async () => {
    const previousUrl = process.env.BOTTEGA_RECORD_API_URL
    const originalFetch = globalThis.fetch
    process.env.BOTTEGA_RECORD_API_URL = 'https://api.example.test'
    const requests: Array<{ url: string; headers: Headers; body: unknown }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push({
        url: request.url,
        headers: request.headers,
        body: await request.json(),
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
    expect(
      recordAuthRefusal(
        422,
        {
          code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
          message: 'User already exists. Use another email.',
        },
        new Headers(),
      ),
    ).toMatchObject({ code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' })
  })

  test.each([
    ['USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', 'changed upstream message', true],
    ['USER_ALREADY_EXISTS', 'changed upstream message', true],
    [null, 'User already exists. Use another email.', true],
    ['DIFFERENT_ERROR', 'User already exists. Use another email.', false],
  ])(
    'classifies an existing account from auth code %p before message %p',
    (code, message, existingAccount) => {
      const error = recordAuthRefusal(422, code ? { code, message } : { message }, new Headers())
      expect(error).toBeInstanceOf(RecordApiRequestError)
      expect(error).toMatchObject({ existingAccount })
    },
  )

  test('validates and maps whoami identity at the HTTP edge', () => {
    const mapped = recordIdentityResponse({
      user: { id: 'user-a', email: 'a@example.test', emailVerified: false },
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
    expect(() =>
      recordIdentityResponse({
        user: { id: 'user-a', email: 'a@example.test' },
        activeSpaceId: null,
        personalSpaceId: null,
        memberships: [],
      }),
    ).toThrow(
      `the hosted record at https://api.bottega.run could not be reached (record API returned an invalid identity); nothing was written\ncleared by:`,
    )
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

test('a bearer is not sent when the install is pinned to another record origin', async () => {
  const previousUrl = process.env.BOTTEGA_RECORD_API_URL
  delete process.env.BOTTEGA_RECORD_API_URL
  db().query('DELETE FROM record_install_binding').run()
  db()
    .query(
      "INSERT INTO record_install_binding(id,bound_at,record_origin) VALUES (1,'2026-11-05','https://staging.example.test')",
    )
    .run()
  let requests = 0
  try {
    await expect(
      recordApiRequest(
        '/v1/whoami',
        {},
        {
          token: () => 'stored-bearer',
          tokenAsync: async () => 'stored-bearer',
        },
        (async () => {
          requests += 1
          return Response.json({})
        }) as unknown as typeof fetch,
      ),
    ).rejects.toThrow('record use https://staging.example.test')
    expect(requests).toBe(0)
  } finally {
    db().query('DELETE FROM record_install_binding').run()
    if (previousUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = previousUrl
  }
})

describe('project-space conflict response', () => {
  let previousUrl: string | undefined
  beforeEach(() => {
    previousUrl = process.env.BOTTEGA_RECORD_API_URL
    process.env.BOTTEGA_RECORD_API_URL = 'https://api.example.test'
  })
  afterEach(() => {
    if (previousUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = previousUrl
  })

  test('a project-space 409 becomes a typed conflict carrying its remedy', async () => {
    const conflict = {
      projectId: '01990000-0000-7000-8000-000000000001',
      projectName: 'alpha',
      spaceId: '01990000-0000-7000-8000-000000000002',
    }
    let rejection: unknown
    try {
      await recordApiRequest(
        '/v1/projects',
        { method: 'PUT' },
        {
          token: () => 'stored-bearer',
          tokenAsync: async () => 'stored-bearer',
        },
        (async () =>
          Response.json(
            { code: 'project_space_conflict', error: 'server message', ...conflict },
            { status: 409 },
          )) as unknown as typeof fetch,
      )
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBeInstanceOf(RecordProjectSpaceConflictError)
    expect(rejection).toMatchObject(conflict)
    expect((rejection as Error).message).toContain(
      `${PLATFORM_SLUG} project set alpha --settings '{"space":"<owning-space-slug>"}'`,
    )
    expect((rejection as Error).message).toContain(`${PLATFORM_SLUG} record space switch <slug>`)
  })
})

describe('revision conflict response', () => {
  const authentication = {
    token: () => 'stored-bearer',
    tokenAsync: async () => 'stored-bearer',
  }

  test('classifies the typed 409 with its current revision', async () => {
    await expect(
      recordApiRequest('/v1/docs/example', {}, authentication, (async () =>
        Response.json(
          {
            error: 'current revision is revision-b; re-read, then retry',
            code: 'revision-conflict',
            currentRevision: 'revision-b',
          },
          { status: 409 },
        )) as unknown as typeof fetch),
    ).rejects.toMatchObject({ kind: 'conflict', currentRevision: 'revision-b', status: 409 })
  })

  test('keeps a missing-revision refusal classified as refused', async () => {
    await expect(
      recordApiRequest('/v1/docs/example', {}, authentication, (async () =>
        Response.json(
          { error: 'cleared by: repair the document revision state, then retry the write' },
          { status: 409 },
        )) as unknown as typeof fetch),
    ).rejects.toMatchObject({ kind: 'refused', currentRevision: null, status: 409 })
  })
})

describe('record API session refresh', () => {
  beforeEach(() => forgetRecordSessionToken())
  afterEach(() => forgetRecordSessionToken())

  test('a changed token after 401 retries once', async () => {
    const session = memoryRecordSession()
    session.setToken('first-token')
    installRecordSessionRunner(session.runner)
    let requests = 0
    try {
      await expect(
        recordApiRequest('/v1/whoami', {}, undefined, (async (_input, init) => {
          requests += 1
          if (requests === 1) {
            expect(new Headers(init?.headers).get('authorization')).toBe('Bearer first-token')
            session.setToken('second-token')
            return Response.json({ error: 'expired' }, { status: 401 })
          }
          expect(new Headers(init?.headers).get('authorization')).toBe('Bearer second-token')
          return Response.json({ ok: true })
        }) as typeof fetch),
      ).resolves.toEqual({ ok: true })
      expect(requests).toBe(2)
    } finally {
      installRecordSessionRunner(null)
    }
  })

  test('the same token after 401 does not retry', async () => {
    const session = memoryRecordSession()
    session.setToken('same-token')
    installRecordSessionRunner(session.runner)
    let requests = 0
    try {
      await expect(
        recordApiRequest('/v1/whoami', {}, undefined, (async () => {
          requests += 1
          return Response.json({ error: 'expired' }, { status: 401 })
        }) as unknown as typeof fetch),
      ).rejects.toMatchObject({ kind: 'refused' })
      expect(requests).toBe(1)
    } finally {
      installRecordSessionRunner(null)
    }
  })
})

test('a bearer is not sent when the bound install has no recorded origin', async () => {
  const previousUrl = process.env.BOTTEGA_RECORD_API_URL
  delete process.env.BOTTEGA_RECORD_API_URL
  db().query('DELETE FROM record_install_binding').run()
  db()
    .query(
      "INSERT INTO record_install_binding(id,bound_at,record_origin) VALUES (1,'2026-11-05',NULL)",
    )
    .run()
  let requests = 0
  try {
    await expect(
      recordApiRequest(
        '/v1/whoami',
        {},
        {
          token: () => 'stored-bearer',
          tokenAsync: async () => 'stored-bearer',
        },
        (async () => {
          requests += 1
          return Response.json({})
        }) as unknown as typeof fetch,
      ),
    ).rejects.toThrow('record use <address>')
    expect(requests).toBe(0)
  } finally {
    db().query('DELETE FROM record_install_binding').run()
    if (previousUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = previousUrl
  }
})

test('record API requests store success and transport-error outcomes', async () => {
  const previousUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.BOTTEGA_RECORD_API_URL = 'https://api.example.test'
  const authentication = {
    token: () => 'stored-bearer',
    tokenAsync: async () => 'stored-bearer',
  }
  const cases = [
    {
      name: 'success',
      transport: (async () =>
        Response.json({ ok: true }, { status: 200 })) as unknown as typeof fetch,
      expected: { http_status: 200, transport_error: null },
    },
    {
      name: 'transport error',
      transport: (async () => {
        throw new Error('fixture transport failure')
      }) as unknown as typeof fetch,
      expected: { http_status: null, transport_error: 'other' },
    },
  ]

  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (const fixture of cases) {
      db().query('DELETE FROM hosted_call_outcome').run()
      const request = recordApiRequest('/v1/docs/example', {}, authentication, fixture.transport)
      if (fixture.name === 'success') await expect(request).resolves.toEqual({ ok: true })
      else await expect(request).rejects.toThrow('fixture transport failure')
      await new Promise((resolve) => setTimeout(resolve, 0))

      const rows = db()
        .query(
          `SELECT route_class,http_status,transport_error,latency_ms
           FROM hosted_call_outcome ORDER BY rowid`,
        )
        .all() as Array<{
        route_class: string
        http_status: number | null
        transport_error: string | null
        latency_ms: number
      }>
      expect(rows, fixture.name).toHaveLength(1)
      expect(rows[0], fixture.name).toEqual({
        route_class: 'record-docs',
        ...fixture.expected,
        latency_ms: expect.any(Number),
      })
      expect(rows[0]?.latency_ms, fixture.name).toBeGreaterThanOrEqual(0)
    }
  } finally {
    if (previousUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = previousUrl
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
      const request = input instanceof Request ? input : new Request(input, init)
      calls.push({
        url: request.url,
        headers: request.headers,
        credentials: init?.credentials ?? request.credentials,
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
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push((input instanceof Request ? input : new Request(input, init)).headers)
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
      const request = input instanceof Request ? input : new Request(input, init)
      const body = await request.text()
      calls.push({
        url: request.url,
        method: request.method,
        body: body ? JSON.parse(body) : null,
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
    const calls: Array<{ url: string; method: string; body: unknown; signal: AbortSignal | null }> =
      []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const body = await request.text()
      calls.push({
        url: request.url,
        method: request.method,
        body: body ? JSON.parse(body) : null,
        signal: request.signal,
      })
      return Response.json({ error: 'nope' }, { status: 409 })
    }) as typeof fetch
    try {
      const client = recordApiClient()
      const id = newRecordId()
      const boardController = new AbortController()
      const boardSignal = boardController.signal
      await expect(
        client.listBoardMessages(
          {
            kind: 'question',
            open: true,
            includeEnded: false,
            ownTitlePrefix: 'Hosted pressure: %_',
          },
          boardSignal,
        ),
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
      boardController.abort()
      expect(calls[0]?.signal?.aborted).toBeTrue()
      expect(calls[0]).toMatchObject({
        url: 'https://api.example.test/v1/board/messages?kind=question&open=true&includeEnded=false&ownTitlePrefix=Hosted+pressure%3A+%25_',
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
      expect(await run('throw')).toEqual({
        kind: 'error',
        reason:
          `the hosted record at https://api.example.test could not be reached (connect reset); nothing was written\n` +
          `cleared by: ${PLATFORM_SLUG} record doctor`,
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
