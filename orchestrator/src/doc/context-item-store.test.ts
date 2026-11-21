import { afterEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { rememberHostedRecord } from '../record/install-binding-write.ts'
import {
  contextItemReadFailure,
  contextItemReadSource,
  listContextItems,
} from './context-item-store.ts'

afterEach(() => installRecordApiClient(null))

test('context-item reads select the install authority without fallback', () => {
  expect(contextItemReadSource({ verdict: 'local-authoritative' })).toBe('local')
  expect(contextItemReadSource({ verdict: 'hosted' })).toBe('hosted')
  expect(() =>
    contextItemReadSource({
      verdict: 'refused',
      refusal: 'record binding is unresolved',
      boundOrigin: null,
      resolvedOrigin: 'https://record.example.test',
    }),
  ).toThrow('record binding is unresolved')
})

test('an unreachable hosted context-item read refuses with a remedy', () => {
  expect(() => contextItemReadFailure(new Error('record API 404'))).toThrow('record API 404')
  expect(() => contextItemReadFailure(new Error('record API 404'))).toThrow(
    `remedy: run \`${PLATFORM_SLUG} record doctor\``,
  )
})

test('hook holder batches make one hosted context-item call', async () => {
  const priorUrl = process.env.BOTTEGA_RECORD_API_URL
  let calls = 0
  try {
    process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
    rememberHostedRecord(db())
    installRecordApiClient({
      ...createMemoryRecordApiClient(),
      listContextItems: async () => {
        calls++
        return []
      },
    })
    await listContextItems(['session:one', 'task:two', 'cursor:three'])
    expect(calls).toBe(1)
  } finally {
    if (priorUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = priorUrl
  }
})
