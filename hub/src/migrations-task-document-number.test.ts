import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MIGRATIONS_FOLDER, stripSqlComments } from './migrations.ts'

function applyMigration(database: Database) {
  const source = readFileSync(join(MIGRATIONS_FOLDER, '0018_task_document_number.sql'), 'utf8')
  for (const statement of source.split('--> statement-breakpoint')) {
    const sql = stripSqlComments(statement).trim()
    if (sql) database.exec(sql)
  }
}

test('document migration assigns stable per-task numbers and removes integer identity', () => {
  const database = new Database(':memory:')
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE task(record_id TEXT NOT NULL PRIMARY KEY);
    INSERT INTO task VALUES ('task-a'),('task-b'),('task-c');
    CREATE TABLE task_document(
      id INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT,
      task_key TEXT NOT NULL, task_record_id TEXT NOT NULL REFERENCES task(record_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      role TEXT CHECK(role IN ('handoff')), title TEXT NOT NULL, body TEXT NOT NULL,
      version TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX task_document_record_id ON task_document(record_id)
      WHERE record_id IS NOT NULL;
    CREATE UNIQUE INDEX task_document_one_role ON task_document(task_record_id,role)
      WHERE role IS NOT NULL;
    CREATE INDEX task_document_task ON task_document(task_record_id,created_at,id);
    CREATE INDEX task_document_task_record_id ON task_document(task_record_id);
    INSERT INTO task_document(record_id,task_key,task_record_id,title,body,version,created_at,updated_at)
    VALUES
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','DEV-1','task-a','later uuid','','v','2026-01-01','2026-01-01'),
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','DEV-1','task-a','earlier uuid','','v','2026-01-01','2026-01-01'),
      (NULL,'DEV-1','task-a','last','','v','2026-01-02','2026-01-02'),
      ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','DEV-2','task-b','other task','','v','2026-01-01','2026-01-01');
  `)

  applyMigration(database)

  expect(
    database
      .query<{ title: string; number: number }, []>(
        `SELECT title,number FROM task_document ORDER BY task_record_id,number`,
      )
      .all(),
  ).toEqual([
    { title: 'earlier uuid', number: 1 },
    { title: 'later uuid', number: 2 },
    { title: 'last', number: 3 },
    { title: 'other task', number: 1 },
  ])
  expect(
    database
      .query<{ record_id: string; next_document_number: number }, []>(
        `SELECT record_id,next_document_number FROM task ORDER BY record_id`,
      )
      .all(),
  ).toEqual([
    { record_id: 'task-a', next_document_number: 4 },
    { record_id: 'task-b', next_document_number: 2 },
    { record_id: 'task-c', next_document_number: 1 },
  ])
  const columns = database
    .query<{ name: string; notnull: number; pk: number }, []>(`PRAGMA table_info(task_document)`)
    .all()
  expect(columns.some((column) => column.name === 'id')).toBe(false)
  expect(columns.find((column) => column.name === 'record_id')).toMatchObject({ notnull: 1, pk: 1 })
  expect(columns.find((column) => column.name === 'number')).toMatchObject({ notnull: 1 })
  expect(
    database.query<{ record_id: string }, []>(`SELECT record_id FROM task_document`).all(),
  ).not.toContainEqual({ record_id: null })
  database.close()
})
