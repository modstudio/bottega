import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

function storeBeforeOutbox() {
  const folder = mkdtempSync(join(tmpdir(), 'hub-outbox-migration-'))
  mkdirSync(join(folder, 'meta'))
  const entries = migrationJournal().slice(0, 26)
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

test('outbox migration moves pending tracker status events and retires the setting', () => {
  const database = storeBeforeOutbox()
  database.query(`INSERT INTO setting(key,value) VALUES (?,?)`).run(
    'tracker.status-events.pending-mirror',
    JSON.stringify([
      { eventRecordId: '0199b001-0000-7000-8000-000000000001', at: '2026-10-11T12:00:00Z' },
      { eventRecordId: '0199b001-0000-7000-8000-000000000002', at: '2026-10-11T12:01:00Z' },
    ]),
  )

  expect(applyMigrations(database)).toEqual(['0026_outbox'])
  expect(
    database
      .query(
        `SELECT id,table_name,row_id,operation,queued_at,attempts,last_error,sent_at,
          quarantined_at,quarantine_reason FROM hosted_outbox ORDER BY queued_at`,
      )
      .all(),
  ).toEqual([
    {
      id: '0199b001-0000-7000-8000-000000000001',
      table_name: 'hub_task_status_event',
      row_id: '0199b001-0000-7000-8000-000000000001',
      operation: 'upsert',
      queued_at: '2026-10-11T12:00:00Z',
      attempts: 0,
      last_error: null,
      sent_at: null,
      quarantined_at: null,
      quarantine_reason: null,
    },
    {
      id: '0199b001-0000-7000-8000-000000000002',
      table_name: 'hub_task_status_event',
      row_id: '0199b001-0000-7000-8000-000000000002',
      operation: 'upsert',
      queued_at: '2026-10-11T12:01:00Z',
      attempts: 0,
      last_error: null,
      sent_at: null,
      quarantined_at: null,
      quarantine_reason: null,
    },
  ])
  expect(
    database.query(`SELECT 1 FROM setting WHERE key='tracker.status-events.pending-mirror'`).get(),
  ).toBeNull()
  database.close()
})
