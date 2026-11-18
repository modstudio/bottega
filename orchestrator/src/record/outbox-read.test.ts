import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { PENDING_OUTBOX_ROWS_WITH_PAYLOAD_SQL } from './outbox-dependency.ts'
import { QUARANTINED_OUTBOX_ROWS_SQL, retirePendingOutboxKindsSql } from './outbox-quarantine.ts'
import { PENDING_OUTBOX_COUNT_SQL, preparePendingRowsSql } from './record-sync.ts'

function queryPlan(database: Database, sql: string, parameters: string[] = []): string[] {
  return database
    .query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...parameters)
    .map((row) => row.detail)
}

test('outbox reads use selective indexes', () => {
  const database = migratedTestDatabase()

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
