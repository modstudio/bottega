import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { PENDING_OUTBOX_ROWS_WITH_PAYLOAD_SQL } from './outbox-dependency.ts'
import { QUARANTINED_OUTBOX_ROWS_SQL, retirePendingOutboxKindsSql } from './outbox-quarantine.ts'
import { PENDING_OUTBOX_COUNT_SQL, preparePendingRowsSql } from './record-sync.ts'

function seedOutboxHistory(database: Database): void {
  database.exec(`WITH RECURSIVE sequence(value) AS (
      VALUES(1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 1000
    )
    INSERT INTO outbox (record_id,kind,row_id,payload,created_at,synced_at)
    SELECT printf('00000000-0000-4000-8000-%012d', value),
           'run', printf('row-%d', value), '{}', '2026-01-01T00:00:00.000Z',
           '2026-01-01T00:00:01.000Z'
      FROM sequence`)
  database.exec(`INSERT INTO outbox (record_id,kind,row_id,payload,created_at) VALUES
    ('10000000-0000-4000-8000-000000000001','run','pending-1','{}','2026-01-01T00:00:00.000Z'),
    ('10000000-0000-4000-8000-000000000002','score','pending-2','{}','2026-01-01T00:00:00.000Z')`)
  database.exec(`INSERT INTO outbox
      (record_id,kind,row_id,payload,created_at,quarantined_at,quarantine_reason)
    VALUES ('20000000-0000-4000-8000-000000000001','run','quarantined-1','{}',
            '2026-01-01T00:00:00.000Z','2026-01-01T00:00:01.000Z','delivery failed')`)
}

function queryPlan(database: Database, sql: string, parameters: string[] = []): string[] {
  return database
    .query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...parameters)
    .map((row) => row.detail)
}

test('outbox reads use indexes whose cost follows live rows', () => {
  const database = migratedTestDatabase()
  seedOutboxHistory(database)

  const pendingReads = [
    { sql: retirePendingOutboxKindsSql('?'), parameters: ['retired-kind'] },
    { sql: preparePendingRowsSql('?'), parameters: ['retired-kind'] },
    { sql: PENDING_OUTBOX_COUNT_SQL },
    { sql: PENDING_OUTBOX_ROWS_WITH_PAYLOAD_SQL },
  ]
  for (const read of pendingReads) {
    expect(queryPlan(database, read.sql, read.parameters)).toEqual(
      expect.arrayContaining([expect.stringContaining('outbox_synced_at')]),
    )
  }
  expect(queryPlan(database, QUARANTINED_OUTBOX_ROWS_SQL)).toEqual(
    expect.arrayContaining([expect.stringContaining('outbox_quarantined_live')]),
  )
  database.close()
})
