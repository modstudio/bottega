import { describe, expect, test } from 'bun:test'
import {
  MIGRATION_BOUNDED_PARAMETERS,
  MIGRATION_CLIENT_CHECK_INTERVAL,
  MIGRATION_IDLE_IN_TRANSACTION_TIMEOUT,
  MIGRATION_LOCK_TIMEOUT,
  MIGRATION_STATEMENT_TIMEOUT,
  migrationSessionSettings,
  publishedMigrationSetting,
} from './migration-session.ts'

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
    expect(MIGRATION_BOUNDED_PARAMETERS).toEqual([
      'lock_timeout',
      'statement_timeout',
      'idle_in_transaction_session_timeout',
    ])
    expect(settings.every(([, value]) => !/^0(?:[a-z]+)?$/i.test(value))).toBe(true)
  })
})
