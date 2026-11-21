import { beforeEach, describe, expect, test } from 'bun:test'
import { configClient } from './config-client.ts'
import { forgetConfigReadMemo } from './config-read-memo.ts'
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

  test('a different session token has a separate read', async () => {
    const counts: Counts = new Map()
    const transport = countingTransport(counts)

    await configClient(environment, transport, 'token-a').whoami()
    await configClient(environment, transport, 'token-b').whoami()

    expect(counts.get('GET /v1/whoami')).toBe(2)
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
