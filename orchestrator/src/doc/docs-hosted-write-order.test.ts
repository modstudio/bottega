import { expect, test } from 'bun:test'
import { setDoc } from '../../test/fixtures/docs.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import type { RecordDocUpsertInput } from '../record/record-api-client.ts'
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

test('a hosted document upsert carries the writing session', async () => {
  const previousSession = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = 'hosted-doc-author'
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const client = createMemoryRecordApiClient()
  const requests: RecordDocUpsertInput[] = []
  installRecordApiClient({
    ...client,
    upsertDoc: async (input) => {
      requests.push(input)
      return client.upsertDoc(input)
    },
  })
  try {
    await writeDoc({
      scope: 'global',
      subject: null,
      slug: 'hosted-session',
      title: 'Hosted session',
      body: 'The hosted revision records its author session.',
      delivery: 'demand',
      reason: 'prove hosted session attribution',
    })
    expect(requests[0]?.sessionId).toBe('hosted-doc-author')
  } finally {
    delete process.env.BOTTEGA_RECORD_API_URL
    if (previousSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = previousSession
    installRecordApiClient(createMemoryRecordApiClient())
  }
})
