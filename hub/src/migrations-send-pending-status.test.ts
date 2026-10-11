import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MIGRATIONS_FOLDER, stripSqlComments } from './migrations.ts'

function applySendPendingStatusMigration(database: Database) {
  const source = readFileSync(join(MIGRATIONS_FOLDER, '0025_send_pending_status.sql'), 'utf8')
  for (const statement of source.split('--> statement-breakpoint')) {
    const sql = stripSqlComments(statement).trim()
    if (sql) database.exec(sql)
  }
}

test('send pending-status rebuild preserves rows and constraints', () => {
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE send (
      record_id TEXT NOT NULL PRIMARY KEY,
      at TEXT NOT NULL,
      window TEXT NOT NULL,
      recipients TEXT NOT NULL,
      projects TEXT NOT NULL,
      items INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('sent','skipped','failed')),
      error TEXT,
      test INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO send(record_id,at,window,recipients,projects,items,status,error,test) VALUES
      ('send-one','2026-10-10T12:00:00.000Z','day','["one@example.test"]','["workshop"]',2,'sent',NULL,0),
      ('send-two','2026-10-11T12:00:00.000Z','week','[]','[]',0,'failed','offline',1);
  `)
  const before = database.query('SELECT * FROM send ORDER BY record_id').all()
  const indexesBefore = database.query('PRAGMA index_list(send)').all()

  applySendPendingStatusMigration(database)

  expect(database.query('SELECT * FROM send ORDER BY record_id').all()).toEqual(before)
  expect(database.query('PRAGMA index_list(send)').all()).toEqual(indexesBefore)
  expect(
    database
      .query<{ name: string; notnull: number; pk: number; dflt_value: string | null }, []>(
        'PRAGMA table_info(send)',
      )
      .all(),
  ).toMatchObject([
    { name: 'record_id', notnull: 1, pk: 1, dflt_value: null },
    { name: 'at', notnull: 1, pk: 0, dflt_value: null },
    { name: 'window', notnull: 1, pk: 0, dflt_value: null },
    { name: 'recipients', notnull: 1, pk: 0, dflt_value: null },
    { name: 'projects', notnull: 1, pk: 0, dflt_value: null },
    { name: 'items', notnull: 1, pk: 0, dflt_value: null },
    { name: 'status', notnull: 1, pk: 0, dflt_value: null },
    { name: 'error', notnull: 0, pk: 0, dflt_value: null },
    { name: 'test', notnull: 1, pk: 0, dflt_value: '0' },
  ])
  database
    .query(
      `INSERT INTO send(record_id,at,window,recipients,projects,items,status)
       VALUES ('pending','2026-10-11T13:00:00.000Z','day','[]','[]',0,'pending')`,
    )
    .run()
  expect(() =>
    database
      .query(
        `INSERT INTO send(record_id,at,window,recipients,projects,items,status)
         VALUES ('unknown','2026-10-11T14:00:00.000Z','day','[]','[]',0,'unknown')`,
      )
      .run(),
  ).toThrow()
  expect(() =>
    database
      .query(
        `INSERT INTO send(record_id,at,window,recipients,projects,items,status)
         VALUES ('send-one','2026-10-11T15:00:00.000Z','day','[]','[]',0,'sent')`,
      )
      .run(),
  ).toThrow()
  database.close()
})
