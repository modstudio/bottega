import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { MigrationMeta } from 'drizzle-orm/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
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

  test('accepts a bound restored after its last change', () => {
    expect(() =>
      assertMigrationBounds([
        migration(
          "SET LOCAL statement_timeout = '5min'; SELECT set_config('statement_timeout', current_setting('record_migration.statement_timeout'), true);",
        ),
      ]),
    ).not.toThrow()
  })

  test('refuses a missing restore', () => {
    expect(() =>
      assertMigrationBounds([migration("SELECT set_config('statement_timeout', '5min', false);")]),
    ).toThrow(/fixture_migration.*statement_timeout.*SELECT set_config/)
  })

  test('refuses a restore before the change', () => {
    expect(() =>
      assertMigrationBounds([
        migration(
          "SELECT set_config('statement_timeout', current_setting('record_migration.statement_timeout'), true); SET LOCAL statement_timeout = '5min';",
        ),
      ]),
    ).toThrow(/fixture_migration.*statement_timeout/)
  })

  test('accepts a restore opening the next migration', () => {
    const changed = migration("SET LOCAL statement_timeout = '5min';")
    changed.name = 'first_migration'
    const repair = migration(
      "SELECT set_config('statement_timeout', current_setting('record_migration.statement_timeout'), true); SELECT 1;",
    )
    repair.name = 'second_migration'
    expect(() => assertMigrationBounds([repair, changed])).not.toThrow()
  })

  test('refuses a next migration that does not open with the restore', () => {
    const changed = migration("SET LOCAL statement_timeout = '5min';")
    changed.name = 'first_migration'
    const repair = migration(
      "SELECT 1; SELECT set_config('statement_timeout', current_setting('record_migration.statement_timeout'), true);",
    )
    repair.name = 'second_migration'
    expect(() => assertMigrationBounds([changed, repair])).toThrow(
      /first_migration.*statement_timeout/,
    )
  })

  test('accepts the real migration set', () => {
    const folder = join(import.meta.dir, '..', 'shared', 'record', 'migrations')
    expect(() =>
      assertMigrationBounds(readMigrationFiles({ migrationsFolder: folder })),
    ).not.toThrow()
  })
})
