import { afterEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { setDoc } from '../../test/fixtures/docs.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { readDoc } from './doc-authoritative-read.ts'

afterEach(() => {
  delete process.env.BOTTEGA_RECORD_API_URL
  installRecordApiClient(createMemoryRecordApiClient())
})

test('a hosted read returns the hosted row and never the local mirror', async () => {
  await setDoc({
    scope: 'global',
    subject: null,
    slug: 'authority',
    title: 'Local',
    body: 'local body',
    reason: 'seed a conflicting local mirror',
  })
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    listDocs: async () => ({
      items: [
        {
          id: '01990000-0000-7000-8000-000000000001',
          scope: 'global',
          subject: null,
          owner: null,
          slug: 'authority',
          title: 'Hosted',
          body: 'hosted body',
          delivery: 'demand',
          audiences: ['technical'],
          status: 'current',
          kind: 'working',
          createdAt: '2026-11-22T00:00:00.000Z',
          updatedAt: '2026-11-22T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    }),
  })
  expect((await readDoc('global', null, 'authority'))?.body).toBe('hosted body')
})

test('an unreachable hosted read refuses with the sign-in and retry remedy', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    listDocs: async () => {
      throw new Error('record unavailable')
    },
  })
  await expect(readDoc('global', null, 'authority')).rejects.toThrow(
    `run ${PLATFORM_SLUG} record whoami to verify sign-in, or retry when the hosted record is reachable`,
  )
})
