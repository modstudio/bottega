import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { guardHostedTables } from './hosted-table-guard.ts'

test('hosted install guard refuses listed SQL and allows other tables', () => {
  const database = new Database(':memory:')
  database.exec('CREATE TABLE hosted_row (id TEXT); CREATE TABLE local_row (id TEXT)')
  const guarded = guardHostedTables(database, ['hosted_row'])
  try {
    expect(() => guarded.query('SELECT * FROM hosted_row')).toThrow(
      'hosted_row is held by the hosted record on this install; read or write it through the record API',
    )
    expect(guarded.query('SELECT * FROM local_row').all()).toEqual([])
  } finally {
    database.close()
  }
})
