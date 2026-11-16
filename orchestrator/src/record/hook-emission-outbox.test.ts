import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { backfillHookEmissions } from './hook-emission-outbox.ts'
import { machineId } from './machine-identity.ts'

test('hook emission backfill enqueues every local field once', () => {
  const database = migratedTestDatabase()
  const rowId = '01990000-0000-7000-8000-000000000039'
  const textHash = '7'.repeat(64)
  database
    .query(`INSERT INTO hook_emission
      (record_id,session_id,at,event,hook,kind,chars,lines,text_hash)
      VALUES (?,'session-enqueue','2026-11-15T11:59:00.000Z','PreToolUse','git-guard',
              'denyReason',37,4,?)`)
    .run(rowId, textHash)

  expect(backfillHookEmissions(database, '2026-11-15T12:01:00.000Z')).toBe(1)
  const rows = database
    .query<{ row_id: string; kind: string; payload: string }, []>(
      "SELECT row_id,kind,payload FROM outbox WHERE kind='hook_emission'",
    )
    .all()
  expect(rows).toHaveLength(1)
  expect(rows[0]!.row_id).toBe(rowId)
  expect(JSON.parse(rows[0]!.payload)).toMatchObject({
    id: rowId,
    machineId: machineId(),
    sessionId: 'session-enqueue',
    at: '2026-11-15T11:59:00.000Z',
    event: 'PreToolUse',
    hook: 'git-guard',
    kind: 'denyReason',
    chars: 37,
    lines: 4,
    textHash,
  })

  expect(backfillHookEmissions(database, '2026-11-15T12:02:00.000Z')).toBe(0)
  expect(
    database
      .query<{ count: number }, []>("SELECT count(*) count FROM outbox WHERE kind='hook_emission'")
      .get()!.count,
  ).toBe(1)
  database.close()
})

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
