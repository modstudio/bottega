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

  test('refuses a zero set_config statement timeout', () => {
    expect(() =>
      assertMigrationBounds([migration("SELECT SET_CONFIG('STATEMENT_TIMEOUT', '0min', true);")]),
    ).toThrow(/fixture_migration.*SET_CONFIG.*STATEMENT_TIMEOUT/)
  })

  test('refuses a default statement timeout', () => {
    expect(() =>
      assertMigrationBounds([migration('SET SESSION statement_timeout TO DEFAULT;')]),
    ).toThrow(/fixture_migration.*SET SESSION statement_timeout TO DEFAULT/)
  })

  test('refuses reset all', () => {
    expect(() => assertMigrationBounds([migration('RESET ALL;')])).toThrow(
      /fixture_migration.*RESET ALL/,
    )
  })

  test('accepts a raised local statement timeout', () => {
    expect(() =>
      assertMigrationBounds([migration("SET LOCAL statement_timeout = '5min';")]),
    ).not.toThrow()
  })

  test('accepts a raised set_config statement timeout', () => {
    expect(() =>
      assertMigrationBounds([migration("SELECT set_config('statement_timeout', '5min', false);")]),
    ).not.toThrow()
  })
})
