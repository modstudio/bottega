import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { HUB_MIGRATION_BACKFILL_VALUES } from '../test/migration-values.ts'
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

  applyMigrations(database, undefined, HUB_MIGRATION_BACKFILL_VALUES)
  expect(
    database
      .query(
        `SELECT id,table_name,row_id,operation,queued_at,generation,attempts,last_error,
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
      generation: 1,
      attempts: 0,
      last_error: null,
      quarantined_at: null,
      quarantine_reason: null,
    },
    {
      id: '0199b001-0000-7000-8000-000000000002',
      table_name: 'hub_task_status_event',
      row_id: '0199b001-0000-7000-8000-000000000002',
      operation: 'upsert',
      queued_at: '2026-10-11T12:01:00Z',
      generation: 1,
      attempts: 0,
      last_error: null,
      quarantined_at: null,
      quarantine_reason: null,
    },
  ])
  expect(
    database.query(`SELECT 1 FROM setting WHERE key='tracker.status-events.pending-mirror'`).get(),
  ).toBeNull()
  database.close()
})

test('the additive outbox migration brings each queued status event task once', () => {
  const database = storeBeforeOutbox()
  const taskId = '0199b001-0000-7000-8000-000000000010'
  const firstEvent = '0199b001-0000-7000-8000-000000000011'
  const secondEvent = '0199b001-0000-7000-8000-000000000012'
  database
    .query(
      `INSERT INTO task(record_id,key,project,source,first_seen,last_seen)
       VALUES (?,'DEV-10',?,'mcp','2026-10-10T00:00:00.000Z','2026-10-11T00:00:00.000Z')`,
    )
    .run(taskId, PLATFORM_SLUG)
  const insertEvent = database.query(
    `INSERT INTO task_status_event(record_id,task_key,task_record_id,at,from_status,to_status)
     VALUES (?,'DEV-10',?,?,'open','active')`,
  )
  insertEvent.run(firstEvent, taskId, '2026-10-11T12:00:00.000Z')
  insertEvent.run(secondEvent, taskId, '2026-10-11T12:01:00.000Z')
  database.query(`INSERT INTO setting(key,value) VALUES (?,?)`).run(
    'tracker.status-events.pending-mirror',
    JSON.stringify([
      { eventRecordId: firstEvent, at: '2026-10-11T12:00:00.000Z' },
      { eventRecordId: secondEvent, at: '2026-10-11T12:01:00.000Z' },
    ]),
  )

  applyMigrations(database, undefined, HUB_MIGRATION_BACKFILL_VALUES)
  expect(
    database
      .query(`SELECT table_name,row_id,queued_at FROM hosted_outbox ORDER BY table_name,row_id`)
      .all(),
  ).toEqual([
    { table_name: 'hub_task', row_id: taskId, queued_at: '2026-10-11T12:00:00.000Z' },
    {
      table_name: 'hub_task_status_event',
      row_id: firstEvent,
      queued_at: '2026-10-11T12:00:00.000Z',
    },
    {
      table_name: 'hub_task_status_event',
      row_id: secondEvent,
      queued_at: '2026-10-11T12:01:00.000Z',
    },
  ])
  database.close()
})
