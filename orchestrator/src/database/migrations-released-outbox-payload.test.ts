import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations, migrationJournal } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

// Applying any pending migration re-executes every compatible backfill, so each one must
// tolerate the empty payload a delivered outbox row keeps once the record has held it.
test('re-executed backfills tolerate released outbox payloads', () => {
  const newest = migrationJournal().at(-1)!.tag
  const database = migrationBoundaryTestDatabase(newest)
  try {
    for (const kind of ['run', 'review', 'landing']) {
      database
        .query(
          `INSERT INTO outbox (record_id,kind,row_id,payload,created_at)
           VALUES (?,?,?,'','2026-11-06T00:00:00.000Z')`,
        )
        .run(newRecordId(), kind, newRecordId())
    }
    expect(applyMigrations(database)).toContain(newest)
    expect(
      database.query<{ n: number }, []>("SELECT count(*) n FROM outbox WHERE payload=''").get()!.n,
    ).toBe(3)
  } finally {
    database.close()
  }
})
