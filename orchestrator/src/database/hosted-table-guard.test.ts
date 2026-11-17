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
    expect(guarded.query('SELECT 1 AS hosted_row').get()).toEqual({ hosted_row: 1 })
  } finally {
    database.close()
  }
})

test('hosted install guard matches each table-reference form but not a column name', () => {
  const database = new Database(':memory:')
  database.exec('CREATE TABLE local_row (question TEXT, question_mutation_audit TEXT)')
  const guarded = guardHostedTables(database, ['question'])
  try {
    expect(guarded.query('SELECT question FROM local_row').all()).toEqual([])
    for (const sql of [
      'SELECT * FROM question',
      'SELECT * FROM main.question',
      'SELECT * FROM "main"."question"',
      'SELECT * FROM run, question',
      'SELECT * FROM local_row JOIN question ON true',
      'INSERT INTO question DEFAULT VALUES',
      'UPDATE question SET question=NULL',
      'CREATE TABLE question (id TEXT)',
      'DELETE FROM question',
    ])
      expect(() => guarded.query(sql)).toThrow('question is held by the hosted record')
    expect(guarded.query('SELECT question_mutation_audit FROM local_row').all()).toEqual([])
  } finally {
    database.close()
  }
})
