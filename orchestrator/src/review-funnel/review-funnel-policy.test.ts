import { afterEach, expect, test } from 'bun:test'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import {
  activeReviewFunnelPolicy,
  DEFAULT_REVIEW_FUNNEL_POLICY,
} from './review-funnel-policy.ts'

const revisionId = '01990000-0000-7000-8000-000000000301'

afterEach(() => {
  delete process.env.BOTTEGA_RECORD_API_URL
  installRecordApiClient(createMemoryRecordApiClient())
})

test('active policy reads the hosted row when the local mirror is empty', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const client = createMemoryRecordApiClient()
  client.listDocs = async () => ({
    items: [
      {
        id: '01990000-0000-7000-8000-000000000300',
        scope: 'global',
        subject: null,
        owner: null,
        slug: 'review-funnel-policy',
        title: 'Review funnel policy',
        body: JSON.stringify(DEFAULT_REVIEW_FUNNEL_POLICY),
        delivery: 'demand',
        audiences: ['technical'],
        status: 'current',
        kind: 'working',
        position: 0,
        featured: false,
        latestRevisionId: revisionId,
        createdAt: '2026-11-22T00:00:00.000Z',
        updatedAt: '2026-11-22T00:00:00.000Z',
      },
    ],
    nextCursor: null,
  })
  installRecordApiClient(client)

  await expect(activeReviewFunnelPolicy()).resolves.toEqual({
    policy: DEFAULT_REVIEW_FUNNEL_POLICY,
    policyVersion: revisionId,
  })
})

test('active policy refuses when the hosted record is unreachable', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const client = createMemoryRecordApiClient()
  client.listDocs = async () => {
    throw new Error('fixture unavailable')
  }
  installRecordApiClient(client)

  await expect(activeReviewFunnelPolicy()).rejects.toThrow(
    /hosted documents could not be read: fixture unavailable.*record whoami/s,
  )
})
