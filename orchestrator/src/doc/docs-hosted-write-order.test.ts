import { expect, test } from 'bun:test'
import { setDoc } from '../../test/fixtures/docs.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import type { RecordDocUpsertInput } from '../record/record-api-client.ts'
import { getDoc, importDoc, setDoc as writeDoc } from './docs.ts'

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
    expect(requests[0]?.op).toBe('create')
  } finally {
    delete process.env.BOTTEGA_RECORD_API_URL
    if (previousSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = previousSession
    installRecordApiClient(createMemoryRecordApiClient())
  }
})

test('a hosted write declares requested, derived create, and derived set operations', async () => {
  const local = await setDoc({
    scope: 'global',
    subject: null,
    slug: 'hosted-derived-set-local',
    title: 'Hosted derived set local',
    body: 'The local row makes the hosted write a set.',
    delivery: 'demand',
    reason: 'create local fixture',
  })
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const client = createMemoryRecordApiClient()
  const hostedOnly = await client.upsertDoc({
    scope: 'global',
    subject: null,
    slug: 'hosted-derived-set-expected',
    title: 'Hosted derived set expected',
    body: 'The hosted-only row has no local prior.',
    delivery: 'demand',
    audiences: [],
    position: 0,
    reason: 'create hosted-only fixture',
    author: 'tester',
  })
  const requests: RecordDocUpsertInput[] = []
  installRecordApiClient({
    ...client,
    upsertDoc: async (input) => {
      requests.push(input)
      return client.upsertDoc(input)
    },
  })
  try {
    await importDoc({
      scope: 'global',
      subject: null,
      slug: 'hosted-requested-import',
      title: 'Hosted requested import',
      body: 'The caller explicitly requests import.',
      delivery: 'demand',
      reason: 'pin requested operation',
    })
    await writeDoc({
      scope: local.scope,
      subject: local.subject,
      slug: local.slug,
      title: local.title,
      body: 'The local row is revised through hosted set.',
      delivery: local.delivery,
      reason: 'pin set with local prior',
    })
    await writeDoc({
      scope: 'global',
      subject: null,
      slug: 'hosted-derived-set-expected',
      title: 'Hosted derived set expected',
      body: 'The expected hosted revision makes this a set.',
      delivery: 'demand',
      expectedRevision: hostedOnly.revisionId,
      reason: 'pin set without local prior',
    })

    expect(requests.map(({ op }) => op)).toEqual(['import', 'set', 'set'])
  } finally {
    delete process.env.BOTTEGA_RECORD_API_URL
    installRecordApiClient(createMemoryRecordApiClient())
  }
})
