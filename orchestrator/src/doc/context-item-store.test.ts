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
  getContextItem,
  listContextHolders,
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

test('failing hosted readers refuse through the store seam without a local fallback', async () => {
  const priorUrl = process.env.BOTTEGA_RECORD_API_URL
  const holderId = `local-fallback-${crypto.randomUUID()}`
  const holder = `session:${holderId}`
  try {
    process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
    rememberHostedRecord(db())
    db()
      .query(
        `INSERT INTO context_item
         (record_id,holder_kind,holder_id,slug,kind,body,source,created_at,updated_at)
         VALUES (?, 'session', ?, 'local-only', 'fact', 'stale', 'test', ?, ?)`,
      )
      .run(crypto.randomUUID(), holderId, new Date().toISOString(), new Date().toISOString())
    const reject = async () => {
      throw new Error('record API 503')
    }
    installRecordApiClient({
      ...createMemoryRecordApiClient(),
      whoami: async () => ({
        user: { id: 'user-a' },
        activeSpaceId: 'personal-space',
        personalSpaceId: 'personal-space',
        memberships: [{ space_id: 'personal-space', slug: 'personal', permission: 'write' }],
      }),
      listContextItems: reject,
      getContextItem: reject,
      listContextHolders: reject,
    })

    for (const read of [
      () => listContextItems(holder),
      () => getContextItem(holder, 'local-only'),
      () => listContextHolders('session'),
    ]) {
      await expect(read()).rejects.toThrow('record API 503')
      await expect(read()).rejects.toThrow(`remedy: run \`${PLATFORM_SLUG} record doctor\``)
    }
  } finally {
    db().query("DELETE FROM context_item WHERE holder_kind='session' AND holder_id=?").run(holderId)
    if (priorUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = priorUrl
  }
})

test('hook holder batches make one hosted context-item call', async () => {
  const priorUrl = process.env.BOTTEGA_RECORD_API_URL
  let calls = 0
  try {
    process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
    rememberHostedRecord(db())
    installRecordApiClient({
      ...createMemoryRecordApiClient(),
      whoami: async () => ({
        user: { id: 'user-a' },
        activeSpaceId: 'personal-space',
        personalSpaceId: 'personal-space',
        memberships: [{ space_id: 'personal-space', slug: 'personal', permission: 'write' }],
      }),
      listContextItems: async () => {
        calls++
        return []
      },
    })
    await listContextItems(['session:one', 'session:two', 'session:three'])
    expect(calls).toBe(1)
  } finally {
    if (priorUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = priorUrl
  }
})
