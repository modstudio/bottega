import { describe, expect, test } from 'bun:test'
import { createMemoryRecordApiClient, installRecordApiClient } from '../../test/fixtures/record-api.ts'
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
})
