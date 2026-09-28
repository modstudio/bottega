import { Database } from 'bun:sqlite'
import { expect, mock, test } from 'bun:test'
import * as installRoot from '../../shared/install-root.ts'
import { MIGRATIONS_TABLE } from './migrations.ts'

mock.module('../../shared/install-root.ts', () => ({
  ...installRoot,
  isAuthorizedPlatformInstallation: () => false,
}))

const { DB_PATH, migrateDatabase, unauthorizedHubMigrationMessage } = await import('./db.ts')

test('an unauthorized installation cannot migrate an existing default store', () => {
  const database = new Database(DB_PATH)
  const journalBefore = database
    .query(`SELECT hash, created_at, version FROM ${MIGRATIONS_TABLE} ORDER BY created_at`)
    .all()
  database.close()
  const explicitPath = process.env.HUB_DB
  delete process.env.HUB_DB

  try {
    expect(() => migrateDatabase()).toThrow(unauthorizedHubMigrationMessage(DB_PATH))
  } finally {
    if (explicitPath === undefined) delete process.env.HUB_DB
    else process.env.HUB_DB = explicitPath
  }

  const unchanged = new Database(DB_PATH)
  expect(
    unchanged
      .query(`SELECT hash, created_at, version FROM ${MIGRATIONS_TABLE} ORDER BY created_at`)
      .all(),
  ).toEqual(journalBefore)
  unchanged.close()
})
