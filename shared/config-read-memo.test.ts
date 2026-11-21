import { beforeEach, describe, expect, test } from 'bun:test'
import { configClient } from './config-client.ts'
import {
  forgetConfigReadMemo,
  memoizedConfigRead,
  RECORD_IDENTITY_MEMO_MAX_AGE_MS,
} from './config-read-memo.ts'
import { RECORD_SPACE_HEADER_NAME } from './record-request-headers.ts'
import { forgetRecordSessionToken } from './record-session.ts'

type Counts = Map<string, number>

function responseFor(path: string): Response {
  if (path === '/v1/whoami')
    return Response.json({
      user: { id: 'user-a' },
      activeSpaceId: 'space-a',
      personalSpaceId: 'space-a',
      memberships: [],
    })
  if (path.startsWith('/v1/config/secrets/'))
    return Response.json({
      key: 'secret-a',
      environment: 'default',
      scope: 'user',
      dekId: 'data-key-a',
      rowVersion: 1,
      updatedAt: '2026-11-20T00:00:00.000Z',
      envelope: 'envelope-a',
    })
  if (path.startsWith('/v1/config/data-keys/'))
    return Response.json({
      id: 'data-key-a',
      version: 1,
      createdAt: '2026-11-20T00:00:00.000Z',
      retiredAt: null,
      wraps: [],
    })
  if (path === '/v1/config/trust-log') return Response.json({ entries: [] })
  return Response.json({ items: [] })
}

function countingTransport(counts: Counts, rejectFirstWhoami = false): typeof fetch {
  let rejected = false
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(typeof input === 'string' ? input : input.toString()).pathname
      const key = `${init?.method ?? 'GET'} ${path}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
      if (rejectFirstWhoami && path === '/v1/whoami' && !rejected) {
        rejected = true
        throw new Error('record unavailable')
      }
      return responseFor(path)
    },
    { preconnect: fetch.preconnect },
  )
}

const environment = { BOTTEGA_RECORD_API_URL: 'https://record.test' }

beforeEach(() => forgetConfigReadMemo())

describe('hosted configuration read memo', () => {
  test('reads are shared within the age bound and reloaded after it', async () => {
    const identityKey = {}
    let loads = 0
    let now = 1_000
    const read = () =>
      memoizedConfigRead(
        identityKey,
        'https://record.test',
        'token-a',
        '/v1/whoami',
        undefined,
        undefined,
        async () => ++loads,
        () => now,
      )

    expect(await read()).toBe(1)
    now += RECORD_IDENTITY_MEMO_MAX_AGE_MS - 1
    expect(await read()).toBe(1)
    now += 2
    expect(await read()).toBe(2)
    expect(loads).toBe(2)
  })

  test('separate clients share sequential and concurrent identity and secret-list reads', async () => {
    const counts: Counts = new Map()
    const transport = countingTransport(counts)
    const clients = Array.from({ length: 6 }, () => configClient(environment, transport, 'token-a'))

    await Promise.all(clients.map((client) => client.whoami()))
    await Promise.all(clients.map((client) => client.listSecrets()))
    await clients[0]!.whoami()
    await clients[0]!.listSecrets()

    expect(counts.get('GET /v1/whoami')).toBe(1)
    expect(counts.get('GET /v1/config/secrets')).toBe(1)
  })

  test('a config write clears reads for the same transport, URL, and token', async () => {
    const counts: Counts = new Map()
    const transport = countingTransport(counts)
    const first = configClient(environment, transport, 'token-a')
    const second = configClient(environment, transport, 'token-a')

    await first.whoami()
    await first.putEntry(
      'entry-a',
      { scope: 'user', environment: 'default', value: 'value', expectedRowVersion: null },
      { destinationSpaceId: 'space-a' },
    )
    await second.whoami()

    expect(counts.get('GET /v1/whoami')).toBe(2)
  })

  test('a read racing a config write is cleared after the write settles', async () => {
    let whoamiRequests = 0
    let finishWrite: (() => void) | undefined
    const writeFinished = new Promise<void>((resolve) => {
      finishWrite = resolve
    })
    const transport = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(typeof input === 'string' ? input : input.toString()).pathname
        if ((init?.method ?? 'GET') !== 'GET') {
          await writeFinished
          return Response.json({})
        }
        if (path === '/v1/whoami') whoamiRequests += 1
        return responseFor(path)
      },
      { preconnect: fetch.preconnect },
    )
    const first = configClient(environment, transport, 'token-a')
    const second = configClient(environment, transport, 'token-a')
    const write = first.putEntry(
      'entry-a',
      { scope: 'user', environment: 'default', value: 'value', expectedRowVersion: null },
      { destinationSpaceId: 'space-a' },
    )

    await second.whoami()
    finishWrite?.()
    await write
    await second.whoami()

    expect(whoamiRequests).toBe(2)
  })

  test('a different session token has a separate read', async () => {
    const counts: Counts = new Map()
    const transport = countingTransport(counts)

    await configClient(environment, transport, 'token-a').whoami()
    await configClient(environment, transport, 'token-b').whoami()

    expect(counts.get('GET /v1/whoami')).toBe(2)
  })

  test('secret-list reads are separate for each destination space', async () => {
    let requests = 0
    const transport = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests += 1
        const space = new Headers(init?.headers).get(RECORD_SPACE_HEADER_NAME)
        return Response.json({ items: [{ key: `secret-${space}` }] })
      },
      { preconnect: fetch.preconnect },
    )
    const client = configClient(environment, transport, 'token-a')

    const alpha = await client.listSecrets('default', { destinationSpaceId: 'alpha' })
    const beta = await client.listSecrets('default', { destinationSpaceId: 'beta' })

    expect(requests).toBe(2)
    expect(alpha.map((secret) => secret.key)).toEqual(['secret-alpha'])
    expect(beta.map((secret) => secret.key)).toEqual(['secret-beta'])
  })

  test('a rejected read is retried', async () => {
    const counts: Counts = new Map()
    const transport = countingTransport(counts, true)
    const first = configClient(environment, transport, 'token-a')
    const second = configClient(environment, transport, 'token-a')

    await expect(first.whoami()).rejects.toThrow('hosted config route /v1/whoami is unreachable')
    await expect(second.whoami()).resolves.toMatchObject({ user: { id: 'user-a' } })
    expect(counts.get('GET /v1/whoami')).toBe(2)
  })

  test('secret envelopes and data keys are never memoized', async () => {
    const counts: Counts = new Map()
    const transport = countingTransport(counts)
    const client = configClient(environment, transport, 'token-a')

    await client.getSecret('secret-a', 'user')
    await client.getSecret('secret-a', 'user')
    await client.getDataKey('data-key-a', 'machine-key-a')
    await client.getDataKey('data-key-a', 'machine-key-a')

    expect(counts.get('GET /v1/config/secrets/secret-a')).toBe(2)
    expect(counts.get('GET /v1/config/data-keys/data-key-a')).toBe(2)
  })

  test('forgetting the record session clears configuration reads', async () => {
    const counts: Counts = new Map()
    const transport = countingTransport(counts)
    const first = configClient(environment, transport, 'token-a')
    const second = configClient(environment, transport, 'token-a')

    await first.whoami()
    forgetRecordSessionToken()
    await second.whoami()

    expect(counts.get('GET /v1/whoami')).toBe(2)
  })
})
