import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrationsBefore } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const AUTHOR_BACKFILL = '0098_doc_revision_author_backfill'
const PERSON_ID = '01990000-0000-7000-8000-000000001289'

function databaseBeforeAuthorBackfill(): Database {
  return migrationBoundaryTestDatabase(AUTHOR_BACKFILL)
}

function seedDoc(database: Database, slug: string): number {
  database
    .query(
      `INSERT INTO doc
       (scope,subject,slug,title,body,delivery,audiences,created_at,updated_at,record_id)
       VALUES ('global',NULL,?,'Author backfill','Body','demand','["technical"]',
               '2026-10-12','2026-10-12',?)`,
    )
    .run(slug, `01990000-0000-7000-8000-${slug === 'authors' ? '000000001289' : '000000001290'}`)
  return (database.query('SELECT last_insert_rowid() AS id').get() as { id: number }).id
}

function seedRevision(
  database: Database,
  docId: number,
  reason: string,
  author: string,
  sessionId: string,
  at: string,
): void {
  database
    .query(
      `INSERT INTO doc_revision
       (doc_id,scope,subject,slug,op,title,body,delivery,audiences,author,reason,session_id,at)
       VALUES (?,'global',NULL,'authors','set','Author backfill','Body','demand',
               '["technical"]',?,?,?,?)`,
    )
    .run(docId, author, reason, sessionId, at)
}

test('author backfill uses the cached person before the cutoff and is repeatable', () => {
  const populated = databaseBeforeAuthorBackfill()
  const uncached = databaseBeforeAuthorBackfill()
  try {
    populated
      .query("INSERT INTO schema_meta (key,value) VALUES ('record_signed_in_user', ?)")
      .run(JSON.stringify({ id: PERSON_ID }))
    const docId = seedDoc(populated, 'authors')
    const cases = [
      ['session id', 'session-1289', 'session-one', '2026-10-13T01:59:50.000Z', PERSON_ID],
      ['unknown', 'unknown', 'session-two', '2026-10-13T01:59:51.000Z', PERSON_ID],
      ['typed label', 'codex', 'session-three', '2026-10-13T01:59:52.000Z', PERSON_ID],
      ['migration', 'migration', 'session-four', '2026-10-13T01:59:53.000Z', 'migration'],
      ['person', PERSON_ID, 'session-five', '2026-10-13T01:59:54.000Z', PERSON_ID],
      ['after cutoff', 'later-user', 'session-six', '2026-10-13T02:00:01.000Z', 'later-user'],
      ['at cutoff', 'cutoff-user', 'session-seven', '2026-10-13T02:00:00.000Z', 'cutoff-user'],
    ] as const
    for (const [reason, author, sessionId, at] of cases)
      seedRevision(populated, docId, reason, author, sessionId, at)

    expect(applyMigrationsBefore(populated, '0099_board_reach')).toContain(AUTHOR_BACKFILL)
    expect(applyMigrationsBefore(populated, '0099_board_reach')).toEqual([])
    expect(
      populated.query('SELECT reason,author,session_id FROM doc_revision ORDER BY id').all(),
    ).toEqual(
      cases.map(([reason, , sessionId, , author]) => ({
        reason,
        author,
        session_id: sessionId,
      })),
    )

    const uncachedDocId = seedDoc(uncached, 'uncached')
    seedRevision(
      uncached,
      uncachedDocId,
      'uncached',
      'unknown',
      'session-uncached',
      '2026-10-13T01:59:50.000Z',
    )
    expect(applyMigrationsBefore(uncached, '0099_board_reach')).toContain(AUTHOR_BACKFILL)
    expect(uncached.query('SELECT author,session_id FROM doc_revision').get()).toEqual({
      author: 'unknown',
      session_id: 'session-uncached',
    })
  } finally {
    populated.close()
    uncached.close()
  }
})
