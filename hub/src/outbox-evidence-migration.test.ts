import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

function storeBeforeEvidenceOutbox() {
  const folder = mkdtempSync(join(tmpdir(), 'hub-evidence-outbox-migration-'))
  mkdirSync(join(folder, 'meta'))
  const entries = migrationJournal().slice(0, 28)
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

test('evidence outbox rollout preserves acknowledgements, vanished deletes, and offer-all rows', () => {
  const database = storeBeforeEvidenceOutbox()
  const interval = '01990000-0000-7000-8000-000000008201'
  const vanished = '01990000-0000-7000-8000-000000008202'
  const day = '01990000-0000-7000-8000-000000008203'
  database
    .query(`INSERT INTO interval(record_id,project,source,start_at,end_at,ref)
    VALUES (?,'workshop','orch','2026-10-11T10:00:00.000Z','2026-10-11T10:01:00.000Z','orch:8201')`)
    .run(interval)
  database
    .query(`INSERT INTO day(record_id,day,collected_at)
    VALUES (?,'2026-10-11','2026-10-11T23:00:00.000Z')`)
    .run(day)
  const ledger = database.query(`INSERT INTO record_ledger
    (table_name,local_key,content_hash,synced_at,destination_space_id) VALUES (?,?,?,?,?)`)
  ledger.run('interval', interval, 'hash', '2026-10-11T12:00:00.000Z', 'space-old')
  ledger.run('interval', vanished, 'hash', '2026-10-11T12:01:00.000Z', 'space-gone')

  expect(applyMigrations(database)).toEqual([
    '0028_outbox_evidence',
    '0029_outbox_fields',
    '0030_outbox_kept_values',
    '0031_change_log_pull_cutover',
  ])
  expect(
    database.query(`SELECT hosted_space_id FROM interval WHERE record_id=?`).get(interval),
  ).toEqual({
    hosted_space_id: 'space-old',
  })
  expect(
    database.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_ledger'`).get(),
  ).toBeNull()
  expect(
    database
      .query(`SELECT table_name,row_id,operation,routing_space_id FROM hosted_outbox
    ORDER BY row_id`)
      .all(),
  ).toEqual([
    { table_name: 'hub_interval', row_id: interval, operation: 'upsert', routing_space_id: null },
    {
      table_name: 'hub_interval',
      row_id: vanished,
      operation: 'delete',
      routing_space_id: 'space-gone',
    },
    { table_name: 'hub_day', row_id: day, operation: 'upsert', routing_space_id: null },
  ])
  const serialized = database.serialize()
  expect(applyMigrations(database)).toEqual([])
  expect(database.serialize()).toEqual(serialized)
  database.close()
})
