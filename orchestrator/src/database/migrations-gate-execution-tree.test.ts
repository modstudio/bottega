import { expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

test('gate execution tree migration leaves existing rows without a tree identity', () => {
  const database = migrationBoundaryTestDatabase('0235_gate_execution_tree')
  try {
    database
      .query("INSERT INTO gate_execution(record_id,requested_at) VALUES (?, 'at')")
      .run('01990000-0000-7000-8000-000000002444')
    expect(applyMigrations(database)).toEqual([
      '0235_gate_execution_tree',
      '0236_record_local_by_design',
    ])
    expect(database.query('SELECT tree_id FROM gate_execution').get()).toEqual({ tree_id: null })
  } finally {
    database.close()
  }
})
