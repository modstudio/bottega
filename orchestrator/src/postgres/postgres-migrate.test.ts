import { describe, expect, test } from 'bun:test'
import {
  MIGRATION_CLIENT_CHECK_INTERVAL,
  MIGRATION_IDLE_IN_TRANSACTION_TIMEOUT,
  MIGRATION_LOCK_TIMEOUT,
  MIGRATION_STATEMENT_TIMEOUT,
  migrationSessionSettings,
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
