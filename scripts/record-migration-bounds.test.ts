import { describe, expect, test } from 'bun:test'
import type { MigrationMeta } from 'drizzle-orm/migrator'
import { assertMigrationBounds } from './record-migration-bounds.ts'

function migration(sql: string): MigrationMeta {
  return {
    sql: [sql],
    folderMillis: 0,
    hash: 'fixture',
    bps: false,
    name: 'fixture_migration',
  }
}

describe('record migration bounds', () => {
  test('refuses a disabled statement timeout', () => {
    expect(() => assertMigrationBounds([migration('SET statement_timeout = 0;')])).toThrow(
      /fixture_migration.*SET statement_timeout = 0/,
    )
  })

  test('refuses a reset lock timeout', () => {
    expect(() => assertMigrationBounds([migration('RESET lock_timeout;')])).toThrow(
      /fixture_migration.*RESET lock_timeout/,
    )
  })

  test('accepts a raised local statement timeout', () => {
    expect(() =>
      assertMigrationBounds([migration("SET LOCAL statement_timeout = '5min';")]),
    ).not.toThrow()
  })
})
