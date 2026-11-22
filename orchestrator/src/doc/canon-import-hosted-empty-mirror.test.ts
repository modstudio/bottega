import { afterEach, expect, test } from 'bun:test'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import type { RecordCanonImportInput } from '../record/record-api-client.ts'
import { importCanon } from './canon-import.ts'

afterEach(() => {
  delete process.env.BOTTEGA_RECORD_API_URL
  installRecordApiClient(createMemoryRecordApiClient())
})

test('canon import uses hosted expected revisions when the local mirror is empty', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const docId = '01990000-0000-7000-8000-000000000301'
  const revisionId = '01990000-0000-7000-8000-000000000302'
  const nextRevisionId = '01990000-0000-7000-8000-000000000303'
  const requests: RecordCanonImportInput[] = []
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    listDocs: async () => ({
      items: [
        {
          id: docId,
          scope: 'canon',
          subject: null,
          owner: '01990000-0000-7000-8000-000000000001',
          slug: 'principles',
          title: 'Principles',
          body: 'Prior canon.',
          delivery: 'demand',
          audiences: ['technical'],
          status: 'current',
          kind: 'working',
          position: 0,
          latestRevisionId: revisionId,
          createdAt: '2026-11-22T00:00:00.000Z',
          updatedAt: '2026-11-22T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    }),
    importCanon: async (input) => {
      requests.push(input)
      return {
        rows: [{ slug: 'principles', id: docId, revisionId: nextRevisionId }],
        deletions: [],
        findings: [],
        bootstrap: false,
      }
    },
  })

  await importCanon({
    address: { kind: 'user', owner: '01990000-0000-7000-8000-000000000001' },
    rows: [{ slug: 'principles', title: 'Principles', body: 'Updated canon.' }],
    reason: 'import hosted canon',
  })
  expect(requests[0]?.expectedRevisions).toEqual({ principles: revisionId })
})
