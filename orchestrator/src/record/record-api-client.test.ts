import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { installRecordSessionRunner, memoryRecordSession } from '../../test/fixtures/record-session.ts'
import { recordApiClient } from './record-api-client.ts'

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
      await expect(client.getBoardThread(id)).rejects.toThrow(/nope/)
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
        url: `https://api.example.test/v1/board/threads/${id}`,
        method: 'GET',
      })
      expect(calls[1]).toMatchObject({
        url: 'https://api.example.test/v1/board/messages',
        method: 'PUT',
        body: { id, kind: 'notice', audience: 'operator', title: 'T', body: 'B' },
      })
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
