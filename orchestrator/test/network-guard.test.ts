import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { recordApiClientOver, recordApiRequest } from '../src/record/record-api-client.ts'
import { installRecordSessionRunner, memoryRecordSession } from './fixtures/record-session.ts'
import {
  installTestNetworkGuard,
  testNetworkRefusal,
  testNetworkRequestDecision,
} from './network-guard.ts'

describe('test network request decision', () => {
  const withoutContainer = {}

  test.each([
    'https://api.example.test',
    'http://127.0.0.1.evil.test',
    'http://localhost.evil.test',
  ])('refuses non-loopback URL %s', (url) => {
    expect(testNetworkRequestDecision(url, withoutContainer)).toBe('refuse')
  })

  test.each(['http://localhost:3000', 'http://127.0.0.5', 'http://[::1]:8080'])(
    'allows loopback URL %s',
    (url) => {
      expect(testNetworkRequestDecision(url, withoutContainer)).toBe('allow')
    },
  )

  test('allows a non-loopback URL when a test container is provisioned', () => {
    expect(
      testNetworkRequestDecision('https://api.example.test', {
        BOTTEGA_TEST_POSTGRES_CONTAINER: 'record-postgres',
      }),
    ).toBe('allow')
  })

  test('accepts URL and Request inputs', () => {
    expect(testNetworkRequestDecision(new URL('http://localhost'), withoutContainer)).toBe('allow')
    expect(
      testNetworkRequestDecision(new Request('https://api.example.test'), withoutContainer),
    ).toBe('refuse')
  })
})

describe('installed test network guard', () => {
  let originalFetch: typeof fetch
  let originalRecordApiUrl: string | undefined
  let originalContainer: string | undefined
  let innerCalls = 0
  const guardedUrl = 'https://api.example.test/public/v1/docs'

  beforeEach(() => {
    originalFetch = globalThis.fetch
    originalRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
    originalContainer = process.env.BOTTEGA_TEST_POSTGRES_CONTAINER
    process.env.BOTTEGA_RECORD_API_URL = 'https://api.example.test'
    delete process.env.BOTTEGA_TEST_POSTGRES_CONTAINER
    innerCalls = 0
    installTestNetworkGuard((async () => {
      innerCalls += 1
      return Response.json({ items: [] })
    }) as unknown as typeof fetch)
    const session = memoryRecordSession()
    session.setToken('stream-token')
    installRecordSessionRunner(session.runner)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = originalRecordApiUrl
    if (originalContainer === undefined) delete process.env.BOTTEGA_TEST_POSTGRES_CONTAINER
    else process.env.BOTTEGA_TEST_POSTGRES_CONTAINER = originalContainer
    installRecordSessionRunner(null)
  })

  test('refuses the direct record request client before fetch', async () => {
    await expect(recordApiClientOver(recordApiRequest).listPublicDocs()).rejects.toThrow(
      testNetworkRefusal(guardedUrl),
    )
    expect(innerCalls).toBe(0)
  })

  test('refuses a record request wrapper before fetch', async () => {
    const wrapper = <T>(path: string, init?: RequestInit) => recordApiRequest<T>(path, init)
    await expect(recordApiClientOver(wrapper).listPublicDocs()).rejects.toThrow(
      testNetworkRefusal(guardedUrl),
    )
    expect(innerCalls).toBe(0)
  })

  test('refuses the board stream before fetch', async () => {
    expect(await recordApiClientOver(recordApiRequest).openBoardStream()).toMatchObject({
      kind: 'error',
      reason: expect.stringContaining(
        testNetworkRefusal('https://api.example.test/v1/board/stream'),
      ),
    })
    expect(innerCalls).toBe(0)
  })
})

describe('test fetch replacement', () => {
  let originalFetch: typeof fetch
  let calls = 0

  beforeEach(() => {
    originalFetch = globalThis.fetch
    calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return Response.json({ items: [] })
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('a test stub installed after the preload guard receives the call', async () => {
    expect(await recordApiClientOver(recordApiRequest).listPublicDocs()).toEqual({ items: [] })
    expect(calls).toBe(1)
  })
})
