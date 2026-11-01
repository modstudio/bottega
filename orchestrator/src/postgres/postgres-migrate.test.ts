import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate as migrateWithBunSql } from 'drizzle-orm/bun-sql/migrator'
import {
  formatMigrationNotice,
  MIGRATION_NOTICE_MESSAGE_LIMIT,
  migratePostgresFolder,
  pendingRecordMigrationNames,
} from './postgres-migrate.ts'
import {
  MIGRATION_CLIENT_CHECK_INTERVAL,
  MIGRATION_IDLE_IN_TRANSACTION_TIMEOUT,
  MIGRATION_LOCK_TIMEOUT,
  MIGRATION_STATEMENT_TIMEOUT,
  migrationSessionSettings,
  publishedMigrationSetting,
} from '../../../shared/record/migration-session.ts'

describe('migration session settings', () => {
  test('bounds every migration wait and statement', () => {
    const settings = migrationSessionSettings()

    expect(settings).toEqual([
      ['lock_timeout', MIGRATION_LOCK_TIMEOUT],
      ['statement_timeout', MIGRATION_STATEMENT_TIMEOUT],
      ['idle_in_transaction_session_timeout', MIGRATION_IDLE_IN_TRANSACTION_TIMEOUT],
      [publishedMigrationSetting('lock_timeout'), MIGRATION_LOCK_TIMEOUT],
      [publishedMigrationSetting('statement_timeout'), MIGRATION_STATEMENT_TIMEOUT],
      [
        publishedMigrationSetting('idle_in_transaction_session_timeout'),
        MIGRATION_IDLE_IN_TRANSACTION_TIMEOUT,
      ],
      ['client_connection_check_interval', MIGRATION_CLIENT_CHECK_INTERVAL],
    ])
    expect(settings.every(([, value]) => !/^0(?:[a-z]+)?$/i.test(value))).toBe(true)
  })
})

test('formats a bounded single-line migration notice', () => {
  expect(formatMigrationNotice('20261101000000_fixture', 'first\n  second')).toBe(
    'MIGRATE NOTICE 20261101000000_fixture: first second',
  )
  const bounded = formatMigrationNotice('fixture', 'x'.repeat(MIGRATION_NOTICE_MESSAGE_LIMIT + 1))
  expect(bounded).toEndWith(' …')
  expect(bounded.slice('MIGRATE NOTICE fixture: '.length)).toHaveLength(
    MIGRATION_NOTICE_MESSAGE_LIMIT,
  )
})

test('a journal missing an earlier migration name reports it pending', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'record-pending-migrations-'))
  try {
    for (const name of ['20260101000000_first', '20260102000000_second']) {
      mkdirSync(join(folder, name))
      writeFileSync(join(folder, name, 'migration.sql'), 'SELECT 1;')
    }
    const connection = {
      unsafe: async <T>(query: string): Promise<T[]> =>
        (query.includes('information_schema')
          ? [{ present: true }]
          : [{ name: '20260102000000_second' }]) as T[],
    }

    expect(await pendingRecordMigrationNames(connection, folder)).toEqual(['20260101000000_first'])
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

function fixtureMigrations(): string {
  const folder = mkdtempSync(join(tmpdir(), 'record-migrate-fixture-'))
  const migrations = [
    ['20261101000000_notice_fixture', "DO $$ BEGIN RAISE NOTICE 'fixture notice'; END $$;"],
    ['20261101000001_second_fixture', 'CREATE TABLE fixture_table (id integer PRIMARY KEY);'],
  ] as const
  for (const [name, sql] of migrations) {
    mkdirSync(join(folder, name))
    writeFileSync(join(folder, name, 'migration.sql'), sql)
  }
  return folder
}

const noticeUrl = process.env.BOTTEGA_TEST_MIGRATION_NOTICE_URL
const compatibilityUrl = process.env.BOTTEGA_TEST_MIGRATION_COMPATIBILITY_URL
const realPostgres = noticeUrl && compatibilityUrl ? describe : describe.skip

realPostgres('postgres.js migration notices and journal compatibility', () => {
  test('attributes a server notice to its fixture migration', async () => {
    const folder = fixtureMigrations()
    const lines: string[] = []
    try {
      await migratePostgresFolder(noticeUrl, (line) => lines.push(line), folder)
      expect(lines).toContain('MIGRATE NOTICE 20261101000000_notice_fixture: fixture notice')
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('does not reapply a journal written by the Bun SQL migrator', async () => {
    const folder = fixtureMigrations()
    const sql = new SQL(compatibilityUrl!)
    try {
      await migrateWithBunSql(drizzle({ client: sql }), { migrationsFolder: folder })
      const before = await sql`
        SELECT hash, name FROM drizzle.__drizzle_migrations ORDER BY id
      `
      await migratePostgresFolder(compatibilityUrl!, () => {}, folder)
      const after = await sql`
        SELECT hash, name FROM drizzle.__drizzle_migrations ORDER BY id
      `
      expect(after).toEqual(before)
      expect(after).toHaveLength(2)
    } finally {
      await sql.close()
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
