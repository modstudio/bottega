import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MIGRATION_CLIENT_CHECK_INTERVAL,
  MIGRATION_IDLE_IN_TRANSACTION_TIMEOUT,
  MIGRATION_LOCK_TIMEOUT,
  MIGRATION_STATEMENT_TIMEOUT,
  migrationSessionSettings,
  pendingRecordMigrationNames,
} from './postgres-migrate.ts'

describe('migration session settings', () => {
  test('bounds every migration wait and statement', () => {
    const settings = migrationSessionSettings()

    expect(settings).toEqual([
      ['lock_timeout', MIGRATION_LOCK_TIMEOUT],
      ['statement_timeout', MIGRATION_STATEMENT_TIMEOUT],
      ['idle_in_transaction_session_timeout', MIGRATION_IDLE_IN_TRANSACTION_TIMEOUT],
      ['client_connection_check_interval', MIGRATION_CLIENT_CHECK_INTERVAL],
    ])
    expect(settings.every(([, value]) => !/^0(?:[a-z]+)?$/i.test(value))).toBe(true)
  })
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
