import { expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

test('adds Jev version 2 evidence columns', () => {
  const database = migrationBoundaryTestDatabase('0214_jev_worker_question_v2')
  try {
    expect(applyMigrations(database)).toContain('0214_jev_worker_question_v2')
    const columns = database.query("SELECT name FROM pragma_table_info('question')").all() as {
      name: string
    }[]
    expect(columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['jev_question_version', 'jev_fits', 'jev_order_flipped']),
    )
  } finally {
    database.close()
  }
})
