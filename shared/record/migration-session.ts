export const MIGRATION_LOCK_TIMEOUT = '5s'
export const MIGRATION_STATEMENT_TIMEOUT = '60s'
export const MIGRATION_IDLE_IN_TRANSACTION_TIMEOUT = '30s'
export const MIGRATION_CLIENT_CHECK_INTERVAL = '5s'

export const MIGRATION_BOUNDED_PARAMETERS = [
  'lock_timeout',
  'statement_timeout',
  'idle_in_transaction_session_timeout',
] as const

const MIGRATION_PUBLISHED_SETTING_PREFIX = 'record_migration.'

export function publishedMigrationSetting(parameter: string): string {
  return `${MIGRATION_PUBLISHED_SETTING_PREFIX}${parameter}`
}

export function migrationSessionSettings(): Array<[name: string, value: string]> {
  const boundValues: Record<(typeof MIGRATION_BOUNDED_PARAMETERS)[number], string> = {
    lock_timeout: MIGRATION_LOCK_TIMEOUT,
    statement_timeout: MIGRATION_STATEMENT_TIMEOUT,
    idle_in_transaction_session_timeout: MIGRATION_IDLE_IN_TRANSACTION_TIMEOUT,
  }
  const bounds = MIGRATION_BOUNDED_PARAMETERS.map<[name: string, value: string]>((name) => [
    name,
    boundValues[name],
  ])
  return [
    ...bounds,
    ...bounds.map<[string, string]>(([name, value]) => [publishedMigrationSetting(name), value]),
    ['client_connection_check_interval', MIGRATION_CLIENT_CHECK_INTERVAL],
  ]
}

export function migrationSessionStatements(): string[] {
  return migrationSessionSettings().map(
    ([name, value]) => `SELECT set_config('${name}', '${value}', false)`,
  )
}
