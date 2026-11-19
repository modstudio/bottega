import { expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

test('record local-by-design migration enters the journal', () => {
  const database = migrationBoundaryTestDatabase('0236_record_local_by_design')
  try {
    expect(applyMigrations(database)).toContain('0236_record_local_by_design')
  } finally {
    database.close()
  }
})
