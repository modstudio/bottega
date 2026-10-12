import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

function migratedThrough(lastIndex: number) {
  const folder = mkdtempSync(join(tmpdir(), 'hub-change-log-cutover-'))
  mkdirSync(join(folder, 'meta'))
  const entries = migrationJournal().slice(0, lastIndex + 1)
  for (const entry of entries)
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries }),
  )
  const database = new Database(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  applyMigrations(database, folder)
  rmSync(folder, { recursive: true, force: true })
  return database
}

test('change-log cutover drops comparison evidence and timestamp cursors on a populated store', () => {
  const database = migratedThrough(30)
  database.exec(`INSERT INTO hosted_change_evidence
    (record_id,family,space_id,hosted_table,row_id,kind,differing_columns,observed_at)
    VALUES ('evidence','task','space','hub_task','task','changed-upsert','[]','2026-10-12')`)
  const insert = database.query('INSERT INTO setting(key,value) VALUES (?,?)')
  for (const key of [
    'collect.hosted-tasks.cursor',
    'collect.hosted-tasks.cursor.space',
    'collect.hosted-notes.cursor',
    'collect.hosted-notes.cursor.space',
    'collect.hosted-sends.cursor',
    'collect.hosted-changes.cursor.space',
  ])
    insert.run(key, 'cursor')

  expect(applyMigrations(database)).toEqual([
    '0031_change_log_pull_cutover',
    '0032_outbox_delivery_trace',
    '0033_day_machine',
  ])
  expect(
    database
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hosted_change_evidence'")
      .get(),
  ).toBeNull()
  expect(
    database
      .query<{ key: string }, []>(
        "SELECT key FROM setting WHERE key LIKE 'collect.hosted-%cursor%'",
      )
      .all(),
  ).toEqual([{ key: 'collect.hosted-changes.cursor.space' }])
  database.close()
})

test('the retired timestamp cursors still establish an existing install binding during migration', () => {
  const unbound = migratedThrough(30)
  unbound.exec('DELETE FROM install_binding')
  applyMigrations(unbound)
  expect(unbound.query('SELECT 1 FROM install_binding WHERE id=1').get()).toBeNull()
  unbound.close()

  const bound = migratedThrough(30)
  bound.exec('DELETE FROM install_binding')
  bound.exec(
    `INSERT INTO setting(key,value) VALUES ('collect.hosted-tasks.cursor.space-one','cursor-1')`,
  )
  applyMigrations(bound)
  expect(bound.query('SELECT bound FROM install_binding WHERE id=1').get()).toEqual({ bound: 1 })
  bound.close()
})
