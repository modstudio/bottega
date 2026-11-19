import { expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

test('record local-by-design migration adds an empty singleton mark', () => {
  const database = migrationBoundaryTestDatabase('0236_record_local_by_design')
  try {
    expect(applyMigrations(database)).toEqual(['0236_record_local_by_design'])
    expect(database.query('SELECT id FROM record_local_by_design').all()).toEqual([])
    database.query('INSERT INTO record_local_by_design(id) VALUES (1)').run()
    expect(() =>
      database.query('INSERT INTO record_local_by_design(id) VALUES (2)').run(),
    ).toThrow()
  } finally {
    database.close()
  }
})
