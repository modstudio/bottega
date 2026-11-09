import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HUB_MIGRATION_BACKFILL_VALUES } from '../test/migration-values.ts'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

const migrationTag = '0048_task_retired_reason'

function migratedBeforeRetirementReason(): Database {
  const folder = mkdtempSync(join(tmpdir(), 'hub-task-retirement-migration-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const entries = journal.slice(
    0,
    journal.findIndex((entry) => entry.tag === migrationTag),
  )
  for (const entry of entries)
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries }),
  )
  const database = new Database(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  applyMigrations(database, folder, HUB_MIGRATION_BACKFILL_VALUES)
  rmSync(folder, { recursive: true, force: true })
  return database
}

test('task retirement migration adds a nullable reason without backfilling rows', () => {
  const database = migratedBeforeRetirementReason()
  database.exec(
    `INSERT INTO task(record_id,key,project,source,first_seen,last_seen)
     VALUES ('task-id','DEV-1','workshop','mcp','2026-01-01','2026-01-01')`,
  )

  expect(applyMigrations(database, undefined, HUB_MIGRATION_BACKFILL_VALUES)).toEqual([
    migrationTag,
  ])
  expect(database.query(`SELECT retired_reason FROM task WHERE record_id='task-id'`).get()).toEqual(
    {
      retired_reason: null,
    },
  )
  database.close()
})
