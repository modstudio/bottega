import { expect, test } from 'bun:test'
import { setDoc } from '../../test/fixtures/docs.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { getDoc, setDoc as writeDoc } from './docs.ts'

test('a hosted document write failure leaves the local document unchanged', async () => {
  const local = await setDoc({
    scope: 'global',
    subject: null,
    slug: 'hosted-write-failure',
    title: 'Before hosted failure',
    body: 'Original local body.',
    delivery: 'demand',
    reason: 'create local fixture',
  })
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    upsertDoc: async () => {
      throw new Error('hosted write failed')
    },
  })
  try {
    await expect(
      writeDoc({
        scope: 'global',
        subject: null,
        slug: 'hosted-write-failure',
        title: 'After hosted failure',
        body: 'Must not be stored locally.',
        delivery: 'demand',
        reason: 'prove hosted-first ordering',
      }),
    ).rejects.toThrow('hosted write failed')
    expect(getDoc('global', null, 'hosted-write-failure')).toEqual(local)
  } finally {
    delete process.env.BOTTEGA_RECORD_API_URL
    installRecordApiClient(createMemoryRecordApiClient())
  }
})
