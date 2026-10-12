import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

function storeBeforeSendFamily() {
  const folder = mkdtempSync(join(tmpdir(), 'hub-change-evidence-family-migration-'))
  mkdirSync(join(folder, 'meta'))
  const entries = migrationJournal().slice(0, 24)
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

test('send-family migration preserves evidence and admits send rows', () => {
  const d = storeBeforeSendFamily()
  const insert = d.query(`INSERT INTO hosted_change_evidence
    (record_id,observed_at,family,space_id,hosted_table,row_id,kind,differing_columns)
    VALUES (?,?,?,?,?,?,?,?)`)
  insert.run(
    'task-record',
    '2026-10-11T12:00:00.000Z',
    'task',
    'space-one',
    'hub_task',
    'task-1',
    'changed-upsert',
    '["status"]',
  )
  insert.run(
    'note-record',
    '2026-10-11T12:01:00.000Z',
    'note',
    'space-one',
    'hub_note',
    'note-1',
    'applied-delete',
    '[]',
  )
  const before = d.query('SELECT * FROM hosted_change_evidence ORDER BY record_id').all()

  expect(applyMigrations(d)).toEqual([
    '0024_hosted_change_evidence_send_family',
    '0025_send_pending_status',
    '0026_outbox',
    '0027_outbox_status_event_tasks',
    '0028_outbox_evidence',
    '0029_outbox_fields',
    '0030_outbox_kept_values',
  ])
  expect(d.query('SELECT * FROM hosted_change_evidence ORDER BY record_id').all()).toEqual(before)
  insert.run(
    'send-record',
    '2026-10-11T12:02:00.000Z',
    'send',
    'space-one',
    'hub_send',
    'send-1',
    'changed-upsert',
    '["status"]',
  )
  expect(
    d.query("SELECT family FROM hosted_change_evidence WHERE record_id='send-record'").get(),
  ).toEqual({ family: 'send' })
  expect(
    d
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='hosted_change_evidence' ORDER BY name",
      )
      .all(),
  ).toEqual([
    { name: 'hosted_change_evidence_filters' },
    { name: 'hosted_change_evidence_newest' },
    { name: 'sqlite_autoindex_hosted_change_evidence_1' },
  ])
  d.close()
})
