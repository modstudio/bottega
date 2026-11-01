import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations, applyMigrationsBefore } from './migrations.ts'

test('routing pool sequence migration removes only legacy routing cursors', () => {
  const database = new Database(':memory:')
  try {
    applyMigrationsBefore(database, '0196_routing_pool_sequence_cursor')
    database
      .query('INSERT INTO schema_meta (key,value) VALUES (?,?),(?,?),(?,?)')
      .run(
        'record_routing_pool_cursor:space-a',
        'old-a',
        'record_routing_pool_cursor:space-b',
        'old-b',
        'record_routing_pool_seq:space-a',
        'new-a',
      )

    applyMigrations(database)

    expect(
      database
        .query<{ key: string; value: string }, []>(
          "SELECT key,value FROM schema_meta WHERE key LIKE 'record_routing_pool_%' ORDER BY key",
        )
        .all(),
    ).toEqual([{ key: 'record_routing_pool_seq:space-a', value: 'new-a' }])
  } finally {
    database.close()
  }
})
