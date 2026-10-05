import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from '../database/migrations.ts'
import {
  describeRecordInstallBinding,
  NEVER_BOUND,
  type RecordInstallBinding,
  readRecordInstallBinding,
  rememberHostedRecord,
} from './install-binding.ts'

test('the record install binding is monotonic and records its first binding time', () => {
  expect(readRecordInstallBinding()).toEqual(NEVER_BOUND)
  expect(describeRecordInstallBinding(NEVER_BOUND)).toBe('never bound')

  rememberHostedRecord()
  const first = readRecordInstallBinding()
  expect(first.bound).toBe(true)
  expect(describeRecordInstallBinding(first)).toMatch(/^bound since /)

  rememberHostedRecord()
  expect(readRecordInstallBinding()).toEqual(first)
})

function databaseBeforeBindingMigration(): Database {
  const folder = mkdtempSync(join(tmpdir(), 'orch-binding-migration-'))
  mkdirSync(join(folder, 'meta'))
  const prior = migrationJournal().filter((entry) => entry.tag !== '0079_record_install_binding')
  for (const entry of prior) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  }
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries: prior }),
  )
  const database = new Database(':memory:')
  try {
    applyMigrations(database, folder)
    return database
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

function migratedBinding(seed: (database: Database) => void): RecordInstallBinding {
  const database = databaseBeforeBindingMigration()
  try {
    seed(database)
    expect(applyMigrations(database)).toEqual(['0079_record_install_binding'])
    return readRecordInstallBinding(database)
  } finally {
    database.close()
  }
}

test('the binding migration backfills only from successful hosted-record evidence', () => {
  const syncedOutbox = migratedBinding((database) => {
    database
      .query(
        `INSERT INTO outbox(kind,record_id,payload,created_at,attempts,synced_at)
         VALUES ('run','record-1','{}','2026-10-05',1,'2026-10-05')`,
      )
      .run()
  })
  const hostedDoc = migratedBinding((database) => {
    database
      .query(
        `INSERT INTO doc(scope,subject,slug,title,body,delivery,created_at,updated_at,record_id)
         VALUES ('global',NULL,'hosted','Hosted','body','inject','2026-10-05','2026-10-05','record-2')`,
      )
      .run()
  })
  const cacheCursor = migratedBinding((database) => {
    database
      .query("INSERT INTO schema_meta(key,value) VALUES ('record_docs_cursor','cursor-1')")
      .run()
  })

  expect(syncedOutbox.bound).toBe(true)
  expect(hostedDoc.bound).toBe(true)
  expect(cacheCursor.bound).toBe(true)
  expect(migratedBinding(() => {})).toEqual(NEVER_BOUND)
  expect(
    migratedBinding((database) => {
      database
        .query(
          `INSERT INTO outbox(kind,record_id,payload,created_at,attempts)
           VALUES ('run','record-3','{}','2026-10-05',2)`,
        )
        .run()
    }),
  ).toEqual(NEVER_BOUND)
})
