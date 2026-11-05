import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrationsBefore } from '../database/migrations.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { NEVER_BOUND, readRecordInstallBinding } from './install-binding.ts'
import { rememberHostedRecord } from './install-binding-write.ts'

test('the record install binding is monotonic and records its first binding time', () => {
  const database = migratedTestDatabase()
  expect(readRecordInstallBinding(database)).toEqual(NEVER_BOUND)

  rememberHostedRecord(database)
  const first = readRecordInstallBinding(database)
  expect(first.bound).toBe(true)
  expect(first.recordOrigin).toStartWith('http')

  rememberHostedRecord(database)
  expect(readRecordInstallBinding(database)).toEqual(first)

  database.query('UPDATE record_install_binding SET record_origin=NULL').run()
  rememberHostedRecord(database)
  expect(readRecordInstallBinding(database).recordOrigin).toBe(first.recordOrigin)
  database.close()
})

function databaseBeforeBindingMigration(): Database {
  const database = new Database(':memory:')
  applyMigrationsBefore(database, '0079_record_install_binding')
  return database
}

function migratedBinding(seed: (database: Database) => void): boolean {
  const database = databaseBeforeBindingMigration()
  try {
    seed(database)
    expect(applyMigrationsBefore(database, '0080_hosted_board_cache')).toEqual([
      '0079_record_install_binding',
    ])
    return Boolean(database.query('SELECT 1 FROM record_install_binding WHERE id=1').get())
  } finally {
    database.close()
  }
}

test('the binding migration backfills only from successful hosted-record evidence', () => {
  const syncedOutbox = migratedBinding((database) => {
    database
      .query(
        `INSERT INTO outbox (record_id,kind,payload,created_at,attempts,synced_at) VALUES (?,'run','{}','2026-10-05',1,'2026-10-05')`,
      )
      .run(newRecordId())
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

  expect(syncedOutbox).toBe(true)
  expect(hostedDoc).toBe(true)
  expect(cacheCursor).toBe(true)
  expect(migratedBinding(() => {})).toBe(false)
  expect(
    migratedBinding((database) => {
      database
        .query(
          `INSERT INTO outbox (record_id,kind,payload,created_at,attempts) VALUES (?,'run','{}','2026-10-05',2)`,
        )
        .run(newRecordId())
    }),
  ).toBe(false)
})
