import { expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

test('run quota account migration adds the local account column', () => {
  const database = migrationBoundaryTestDatabase('0238_run_quota_account')
  try {
    expect(applyMigrations(database)).toContain('0238_run_quota_account')
    expect(
      database
        .query<{ name: string; type: string }, []>(`PRAGMA table_info('run')`)
        .all()
        .find((column) => column.name === 'quota_account_id'),
    ).toMatchObject({ name: 'quota_account_id', type: 'TEXT' })
  } finally {
    database.close()
  }
})
