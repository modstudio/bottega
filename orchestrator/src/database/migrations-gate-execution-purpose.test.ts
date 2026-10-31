import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'

test('gate execution purpose defaults existing meaning to gate and rejects unknown values', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  database
    .query("INSERT INTO gate_execution(record_id,requested_at) VALUES (?, 'at')")
    .run('01990000-0000-7000-8000-000000001786')
  expect(database.query('SELECT purpose FROM gate_execution').get()).toEqual({ purpose: 'gate' })
  expect(() =>
    database
      .query("INSERT INTO gate_execution(record_id,requested_at,purpose) VALUES (?, 'at', 'other')")
      .run('01990000-0000-7000-8000-000000001787'),
  ).toThrow()
})
