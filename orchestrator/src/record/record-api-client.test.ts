import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { recordApiBaseUrl, recordApiClient } from './record-api-client.ts'

test('the record API base URL resolves from configured files', () => {
  const root = mkdtempSync(join(tmpdir(), 'record-api-client-url-'))
  try {
    const config = join(root, 'config')
    const harness = join(root, 'harness.env')
    mkdirSync(config)
    writeFileSync(harness, 'ORCH_RECORD_API_URL=https://file.example.test/\n')

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
  test('refuses a real base URL unless a stub is injected', () => {
    installRecordApiClient(null)
    const previous = process.env.ORCH_RECORD_API_URL
    process.env.ORCH_RECORD_API_URL = 'https://api.example.test'
    try {
      expect(() => recordApiClient()).toThrow(
        'record API client refuses a real base URL unless a stub is injected in tests',
      )
    } finally {
      if (previous === undefined) delete process.env.ORCH_RECORD_API_URL
      else process.env.ORCH_RECORD_API_URL = previous
      installRecordApiClient(createMemoryRecordApiClient())
    }
  })

  test('public document methods send neither authorization nor cookies', async () => {
    installRecordSessionRunner(null)
    installRecordApiClient(null)
    const previousEnv = process.env.NODE_ENV
    const previousUrl = process.env.ORCH_RECORD_API_URL
    process.env.NODE_ENV = 'development'
    process.env.ORCH_RECORD_API_URL = 'https://api.example.test'
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
      if (previousUrl === undefined) delete process.env.ORCH_RECORD_API_URL
      else process.env.ORCH_RECORD_API_URL = previousUrl
      installRecordApiClient(createMemoryRecordApiClient())
    }
  })

  test('destination-aware project and id-addressed document calls send x-record-space', async () => {
    const session = memoryRecordSession()
    session.setToken('destination-token')
    installRecordSessionRunner(session.runner)
    installRecordApiClient(null)
    const previousEnv = process.env.NODE_ENV
    const previousUrl = process.env.ORCH_RECORD_API_URL
    process.env.NODE_ENV = 'development'
    process.env.ORCH_RECORD_API_URL = 'https://api.example.test'
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
      if (previousUrl === undefined) delete process.env.ORCH_RECORD_API_URL
      else process.env.ORCH_RECORD_API_URL = previousUrl
      installRecordApiClient(createMemoryRecordApiClient())
    }
  })

  test('board methods use the ruled paths and map a non-success body', async () => {
    const session = memoryRecordSession()
    session.setToken('board-token')
    installRecordSessionRunner(session.runner)
    installRecordApiClient(null)
    const previousEnv = process.env.NODE_ENV
    const previousUrl = process.env.ORCH_RECORD_API_URL
    process.env.NODE_ENV = 'development'
    process.env.ORCH_RECORD_API_URL = 'https://api.example.test'
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
      ).rejects.toThrow(/cleared by: orch record doctor/)
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
    } finally {
      globalThis.fetch = originalFetch
      process.env.NODE_ENV = previousEnv
      if (previousUrl === undefined) delete process.env.ORCH_RECORD_API_URL
      else process.env.ORCH_RECORD_API_URL = previousUrl
      installRecordSessionRunner(null)
      installRecordApiClient(createMemoryRecordApiClient())
    }
  })
})
