import { expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

test('record local-by-design migration adds an empty singleton mark', () => {
  const database = migrationBoundaryTestDatabase('0236_record_local_by_design')
  try {
    expect(applyMigrations(database)).toEqual(['0236_record_local_by_design'])
    expect(database.query('SELECT record_id,mark FROM record_local_by_design').all()).toEqual([])
    database
      .query("INSERT INTO record_local_by_design(record_id,mark) VALUES (?,'local')")
      .run('01990000-0000-7000-8000-000000002477')
    expect(() =>
      database
        .query("INSERT INTO record_local_by_design(record_id,mark) VALUES (?,'hosted')")
        .run('01990000-0000-7000-8000-000000002478'),
    ).toThrow()
  } finally {
    database.close()
  }
})
