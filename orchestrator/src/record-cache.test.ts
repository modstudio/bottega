import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { db } from './db.ts'
import { installRecordApiClient, type RecordApiClient } from './record-api-client.ts'
import { pullRecordCache } from './record-cache.ts'

describe('record cache pull', () => {
  test('applies an update and a soft delete', async () => {
    const docId = newRecordId()
    const client: RecordApiClient = {
      listDocs: async () => ({
        items: [
          {
            id: docId,
            scope: 'machine',
            subject: null,
            slug: 'pulled',
            title: 'Pulled',
            body: 'from-host',
            delivery: 'inject',
            createdAt: '2026-09-16T00:00:00.000Z',
            updatedAt: '2026-09-16T00:00:01.000Z',
            deletedAt: null,
          },
          {
            id: docId,
            scope: 'machine',
            subject: null,
            slug: 'pulled',
            title: 'Pulled',
            body: 'from-host',
            delivery: 'inject',
            createdAt: '2026-09-16T00:00:00.000Z',
            updatedAt: '2026-09-16T00:00:02.000Z',
            deletedAt: '2026-09-16T00:00:02.000Z',
          },
        ],
        nextCursor: null,
      }),
      getDoc: async () => ({}),
      listRevisions: async () => [],
      upsertDoc: async () => ({ id: docId, revisionId: docId }),
      deleteDoc: async () => ({ id: docId, revisionId: docId }),
      consumeDoc: async () => ({ id: docId, revisionId: docId, alreadyConsumed: false }),
      restoreDoc: async () => ({ id: docId, revisionId: docId }),
      renameSubject: async () => ({ docs: 0, revisions: 0 }),
      putScore: async () => undefined,
      voidRun: async () => undefined,
      listScores: async () => ({ items: [], nextCursor: null }),
      counts: async () => ({ docs: 0, revisions: 0, scores: 0, voids: 0 }),
    }
    installRecordApiClient(client)
    const first = await pullRecordCache(db())
    expect(first.docs).toBe(2)
    expect(db().query('SELECT 1 FROM doc WHERE record_id=?').get(docId)).toBeNull()
  })
})
