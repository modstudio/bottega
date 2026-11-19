import { expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

test('record cache cursor rewind removes stranded subject and change cursors only', () => {
  const database = migrationBoundaryTestDatabase('0240_record_cache_cursor_rewind')
  try {
    const insert = database.query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    insert.run('record_subjects_cursor:space-a', 'subject-a')
    insert.run('record_subjects_cursor:space-b', 'subject-b')
    insert.run('record_change_cursor', 'change')
    insert.run('record_docs_cursor:space-a', 'doc')
    insert.run('unrelated', 'kept')

    expect(applyMigrations(database)).toContain('0240_record_cache_cursor_rewind')
    expect(
      database
        .query(
          "SELECT key,value FROM schema_meta WHERE key IN ('record_docs_cursor:space-a','unrelated') ORDER BY key",
        )
        .all(),
    ).toEqual([
      { key: 'record_docs_cursor:space-a', value: 'doc' },
      { key: 'unrelated', value: 'kept' },
    ])
    expect(
      database
        .query(
          "SELECT key FROM schema_meta WHERE key='record_change_cursor' OR key LIKE 'record_subjects_cursor:%'",
        )
        .all(),
    ).toEqual([])
  } finally {
    database.close()
  }
})
