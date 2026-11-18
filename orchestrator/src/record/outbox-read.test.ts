import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { PENDING_OUTBOX_ROWS_WITH_PAYLOAD_SQL } from './outbox-dependency.ts'
import { QUARANTINED_OUTBOX_ROWS_SQL } from './outbox-quarantine.ts'
import { PENDING_OUTBOX_PREDICATE_SQL } from './outbox-read.ts'
import { PENDING_OUTBOX_COUNT_SQL } from './record-sync.ts'

function productionSql(file: string, includes: string): string {
  const source = readFileSync(resolve(import.meta.dir, file), 'utf8')
  const template = [...source.matchAll(/`([^`]*)`/gs)]
    .map((match) => match[1]!)
    .find((sql) => sql.includes(includes))
  expect(template).toBeDefined()
  return template!
    .replace('${PENDING_OUTBOX_PREDICATE_SQL}', PENDING_OUTBOX_PREDICATE_SQL)
    .replace(/\$\{.*?\}/gs, '?')
}

function queryPlan(database: Database, sql: string, parameters: string[] = []): string[] {
  return database
    .query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...parameters)
    .map((row) => row.detail)
}

test('outbox reads use selective indexes', () => {
  const database = migratedTestDatabase()

  const pendingReads = [
    {
      sql: productionSql('outbox-quarantine.ts', 'WHERE kind IN'),
      parameters: ['retired-kind'],
    },
    {
      sql: productionSql('record-sync.ts', 'AND kind NOT IN'),
      parameters: ['retired-kind'],
    },
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
