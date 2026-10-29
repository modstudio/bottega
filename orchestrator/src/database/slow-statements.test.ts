import { expect, test } from 'bun:test'
import { insertContention } from './contention.ts'
import { instrumentDatabase, statementFingerprint } from './slow-statements.ts'
import { migratedTestDatabase } from './test-database.fixture.ts'

test('a statement over the injected threshold records one fingerprinted contention row', () => {
  const raw = migratedTestDatabase()
  const ticks = [0, 11]
  const database = instrumentDatabase(raw, {
    recorder: (fingerprint, durationMs) =>
      insertContention(raw, {
        resourceKind: 'store',
        resourceKey: fingerprint,
        eventKind: 'wait',
        durationMs,
        cause: 'slow-statement',
      }),
    thresholdMs: 10,
    now: () => ticks.shift() ?? 11,
  })

  expect(database.query("SELECT 'literal', 42").get()).toEqual({ "'literal'": 'literal', '42': 42 })

  const rows = raw
    .query(
      `SELECT resource_key,duration_ms
         FROM contention WHERE cause='slow-statement'`,
    )
    .all()
  expect(rows).toEqual([
    {
      resource_key: statementFingerprint("SELECT 'literal', 42"),
      duration_ms: 11,
    },
  ])
  raw.close()
})
