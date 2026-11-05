import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { appliedMigrationCompatibilities } from './applied-migration-compatibilities.ts'

test('returns no compatibility rows when migration metadata is unavailable', () => {
  const database = new Database(':memory:')
  try {
    expect(appliedMigrationCompatibilities(database)).toEqual([])
    database.exec(`CREATE TABLE orch_migrations (
      id INTEGER PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at NUMERIC,
      version TEXT
    )`)
    expect(appliedMigrationCompatibilities(database)).toEqual([])
  } finally {
    database.close()
  }
})

test('returns stored compatibility in applied order', () => {
  const database = new Database(':memory:')
  try {
    database.exec(`CREATE TABLE orch_migrations (
      id INTEGER PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at NUMERIC,
      version TEXT,
      compatibility TEXT
    )`)
    database.exec(`
      INSERT INTO orch_migrations VALUES (3, 'c', 2, 'c', 'fenced');
      INSERT INTO orch_migrations VALUES (2, 'b', 1, 'b', NULL);
      INSERT INTO orch_migrations VALUES (1, 'a', 1, 'a', 'additive');
    `)
    expect(appliedMigrationCompatibilities(database)).toEqual(['additive', null, 'fenced'])
  } finally {
    database.close()
  }
})
