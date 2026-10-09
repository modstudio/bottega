import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MIGRATIONS_FOLDER, stripSqlComments } from './migrations.ts'

function applyUuidIdentityMigration(database: Database) {
  const source = readFileSync(join(MIGRATIONS_FOLDER, '0017_uuid_row_identity.sql'), 'utf8')
  for (const statement of source.split('--> statement-breakpoint')) {
    const sql = stripSqlComments(statement).trim()
    if (sql) database.exec(sql)
  }
}

test('UUID identity rebuild preserves rows, constraints, and missing-id data', () => {
  const database = new Database(':memory:')
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE task(record_id TEXT NOT NULL PRIMARY KEY);
    INSERT INTO task VALUES ('task-id');
    CREATE TABLE task_comment(
      id INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT,
      task_key TEXT NOT NULL, task_record_id TEXT NOT NULL REFERENCES task(record_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      body TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX task_comment_record_id ON task_comment(record_id)
      WHERE record_id IS NOT NULL;
    CREATE INDEX task_comment_task ON task_comment(task_key,created_at);
    CREATE INDEX task_comment_task_record_id ON task_comment(task_record_id);
    CREATE TABLE task_status_event(
      id INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT,
      task_key TEXT NOT NULL, task_record_id TEXT NOT NULL REFERENCES task(record_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      at TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL);
    CREATE UNIQUE INDEX task_status_event_record_id ON task_status_event(record_id)
      WHERE record_id IS NOT NULL;
    CREATE INDEX task_status_event_task_record_id ON task_status_event(task_record_id);
    CREATE INDEX tse_at ON task_status_event(at);
    CREATE UNIQUE INDEX tse_one_per_change
      ON task_status_event(task_record_id,to_status,at);
    CREATE TABLE send(
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, window TEXT NOT NULL,
      recipients TEXT NOT NULL, projects TEXT NOT NULL, items INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('sent','skipped','failed')), error TEXT,
      test INTEGER NOT NULL DEFAULT 0, record_id TEXT);
    CREATE UNIQUE INDEX send_record_id ON send(record_id) WHERE record_id IS NOT NULL;
    INSERT INTO task_comment(record_id,task_key,task_record_id,body,created_at) VALUES
      (NULL,'DEV-1','task-id','missing','2026-10-08'),
      ('comment-id','DEV-1','task-id','existing','2026-10-08');
    INSERT INTO task_status_event(record_id,task_key,task_record_id,at,to_status) VALUES
      (NULL,'DEV-1','task-id','2026-10-08','open'),
      ('event-id','DEV-1','task-id','2026-10-09','active');
    INSERT INTO send(record_id,at,window,recipients,projects,items,status) VALUES
      (NULL,'2026-10-08','day','[]','[]',1,'sent'),
      ('send-id','2026-10-09','day','[]','[]',1,'skipped');
  `)

  applyUuidIdentityMigration(database)

  for (const table of ['task_comment', 'task_status_event', 'send']) {
    const columns = database
      .query<{ name: string; notnull: number; pk: number }, []>(`PRAGMA table_info(${table})`)
      .all()
    expect(columns.some((column) => column.name === 'id')).toBe(false)
    expect(columns.find((column) => column.name === 'record_id')).toMatchObject({
      notnull: 1,
      pk: 1,
    })
    const ids = database.query<{ record_id: string }, []>(`SELECT record_id FROM ${table}`).all()
    expect(ids).toHaveLength(2)
    expect(new Set(ids.map((row) => row.record_id)).size).toBe(2)
    expect(ids.every((row) => row.record_id !== null)).toBe(true)
  }
  expect(() =>
    database
      .query(`INSERT INTO task_status_event
      (record_id,task_key,task_record_id,at,to_status)
      VALUES ('event-duplicate','DEV-1','task-id','2026-10-09','active')`)
      .run(),
  ).toThrow()
  database.close()
})
