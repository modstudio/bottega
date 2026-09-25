import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { installRecordApiClient } from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import type { RecordApiClient } from './record-api-client.ts'
import { pullRecordCache } from './record-cache.ts'

function clientWith(overrides: Partial<RecordApiClient> = {}): RecordApiClient {
  return {
    whoami: async () => ({
      user: { id: newRecordId() },
      activeSpaceId: null,
      personalSpaceId: null,
      memberships: [],
    }),
    inviteMember: async () => ({ id: newRecordId() }),
    putSnapshot: async () => ({ takenAt: new Date().toISOString() }),
    listSnapshots: async () => ({ items: [] }),
    listDocs: async () => ({ items: [], nextCursor: null }),
    getDoc: async () => ({}),
    listRevisions: async () => [],
    upsertDoc: async () => ({ id: newRecordId(), revisionId: newRecordId() }),
    importDoc: async () => ({ id: newRecordId(), revisionIds: [] }),
    importCanon: async () => ({ rows: [], deletions: [], findings: [], bootstrap: false }),
    deleteDoc: async () => ({ id: newRecordId(), revisionId: newRecordId() }),
    consumeDoc: async () => ({
      id: newRecordId(),
      revisionId: newRecordId(),
      alreadyConsumed: false,
    }),
    restoreDoc: async () => ({ id: newRecordId(), revisionId: newRecordId() }),
    renameSubject: async () => ({ docs: 0, revisions: 0 }),
    upsertProject: async () => ({ name: 'unused' }),
    retireProject: async () => ({ name: 'unused' }),
    putScore: async () => undefined,
    voidRun: async () => undefined,
    unvoidRun: async () => undefined,
    listScores: async () => ({ items: [], nextCursor: null }),
    counts: async () => ({ docs: 0, revisions: 0, scores: 0, voids: 0 }),
    ...overrides,
  }
}

describe('record cache pull', () => {
  test('applies an update and a soft delete', async () => {
    const docId = newRecordId()
    const client = clientWith({
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
    })
    installRecordApiClient(client)
    const first = await pullRecordCache(db())
    expect(first.docs).toBe(2)
    expect(db().query('SELECT 1 FROM doc WHERE record_id=?').get(docId)).toBeNull()
  })

  test.each([
    { name: 'scored void', localId: 8911, scored: true },
    { name: 'unscored void', localId: 8912, scored: false },
  ])('clears a cached $name when unvoid follows the pull cursor', async ({ localId, scored }) => {
    const recordId = newRecordId()
    const scoreAt = '2026-09-24T12:00:00.000Z'
    const voidAt = '2026-09-24T12:01:00.000Z'
    const unvoidAt = '2026-09-24T12:02:00.000Z'
    db()
      .query(
        `INSERT INTO run
          (id,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,evidence_excluded)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        localId,
        recordId,
        scoreAt,
        'codex',
        'file-question',
        'sha',
        3,
        'ask',
        'ok',
        'voided with orch score --void',
      )
    if (scored) {
      db()
        .query(
          `INSERT INTO score
            (run_id,delivery,quality,fidelity,note,scored_at,scored_by)
           VALUES (?,'full','right',NULL,'kept',?,'architect')`,
        )
        .run(localId, scoreAt)
    }
    db()
      .query(
        `INSERT INTO schema_meta (key,value) VALUES ('record_scores_cursor',?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(voidAt)
    installRecordApiClient(
      clientWith({
        listScores: async (query) => {
          expect(query.updatedSince).toBe(voidAt)
          return {
            items: [
              {
                runId: recordId,
                delivery: scored ? 'full' : null,
                quality: scored ? 'right' : null,
                fidelity: null,
                note: scored ? 'kept' : null,
                scoredAt: scored ? scoreAt : null,
                scoredBy: scored ? 'architect' : null,
                evidenceExcluded: null,
                updatedAt: unvoidAt,
              },
            ],
            nextCursor: null,
          }
        },
      }),
    )

    expect(await pullRecordCache(db())).toMatchObject({ scores: 1 })
    expect(
      db()
        .query<{ evidence_excluded: string | null }, [number]>(
          'SELECT evidence_excluded FROM run WHERE id=?',
        )
        .get(localId)?.evidence_excluded,
    ).toBeNull()
    expect(db().query('SELECT 1 FROM score WHERE run_id=?').get(localId) !== null).toBe(scored)
  })
})
