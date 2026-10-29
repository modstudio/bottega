import { expect, test } from 'bun:test'
import { instrumentDatabase, statementFingerprint } from './slow-statements.ts'
import { migratedTestDatabase } from './test-database.fixture.ts'

test('a statement over the injected threshold records one fingerprinted contention row', () => {
  const raw = migratedTestDatabase()
  const ticks = [0, 11]
  const database = instrumentDatabase(raw, {
    writable: true,
    thresholdMs: 10,
    now: () => ticks.shift() ?? 11,
  })

  expect(database.query("SELECT 'literal', 42").get()).toEqual({ "'literal'": 'literal', '42': 42 })

  const rows = raw
    .query(
      `SELECT resource_kind,resource_key,event_kind,duration_ms,cause
         FROM contention WHERE cause='slow-statement'`,
    )
    .all()
  expect(rows).toEqual([
    {
      resource_kind: 'store',
      resource_key: statementFingerprint("SELECT 'literal', 42"),
      event_kind: 'wait',
      duration_ms: 11,
      cause: 'slow-statement',
    },
  ])
  raw.close()
})
