import { expect, test } from 'bun:test'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { authenticatedRecordApiClient } from './record-api-client.ts'

test('the HTTP lens client rejects a malformed catalogue response at its decoding boundary', async () => {
  const previousEnvironment = process.env.NODE_ENV
  const previousUrl = process.env.ORCH_RECORD_API_URL
  const originalFetch = globalThis.fetch
  process.env.NODE_ENV = 'development'
  process.env.ORCH_RECORD_API_URL = 'https://api.example.test'
  installRecordApiClient(null)
  globalThis.fetch = (async () =>
    Response.json({ items: [{ id: 1 }], nextCursor: null })) as unknown as typeof fetch
  try {
    const client = authenticatedRecordApiClient({
      token: () => 'test-token',
      tokenAsync: async () => 'test-token',
    })
    await expect(client.listLensCatalogue('lens', {})).rejects.toThrow()
  } finally {
    globalThis.fetch = originalFetch
    process.env.NODE_ENV = previousEnvironment
    if (previousUrl === undefined) delete process.env.ORCH_RECORD_API_URL
    else process.env.ORCH_RECORD_API_URL = previousUrl
    installRecordApiClient(createMemoryRecordApiClient())
  }
})
