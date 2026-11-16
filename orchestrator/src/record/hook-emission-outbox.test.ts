import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { backfillHookEmissions } from './hook-emission-outbox.ts'

test('hook emission backfill is idempotent for an already-enqueued row', () => {
  const database = migratedTestDatabase()
  const rowId = '01990000-0000-7000-8000-000000000041'
  database
    .query(`INSERT INTO hook_emission
      (record_id,session_id,at,event,hook,kind,chars,lines,text_hash)
      VALUES (?,'session-a','2026-11-15T12:00:00.000Z','Stop','stop-summary',
              'systemMessage',12,1,?)`)
    .run(rowId, 'a'.repeat(64))
  database
    .query(`INSERT INTO outbox (record_id,kind,row_id,payload,created_at)
            VALUES ('01990000-0000-7000-8000-000000000042','hook_emission',?,'{}',
                    '2026-11-15T12:00:01.000Z')`)
    .run(rowId)

  expect(backfillHookEmissions(database, '2026-11-15T12:01:00.000Z')).toBe(0)
  expect(
    database
      .query<{ count: number }, []>("SELECT count(*) count FROM outbox WHERE kind='hook_emission'")
      .get()!.count,
  ).toBe(1)
  database.close()
})
