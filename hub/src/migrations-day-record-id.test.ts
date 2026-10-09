import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MIGRATIONS_FOLDER, stripSqlComments } from './migrations.ts'

function applyDayRecordIdMigration(database: Database) {
  const source = readFileSync(join(MIGRATIONS_FOLDER, '0020_day_record_id.sql'), 'utf8')
  for (const statement of source.split('--> statement-breakpoint')) {
    const sql = stripSqlComments(statement).trim()
    if (sql) database.exec(sql)
  }
}

test('day UUID rebuild preserves rows, rewrites ledger keys, and keeps dates unique', () => {
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE day (
      day TEXT PRIMARY KEY,
      claude_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      messages INTEGER NOT NULL DEFAULT 0,
      tasks INTEGER NOT NULL DEFAULT 0,
      canon_tokens INTEGER NOT NULL DEFAULT 0,
      other_tokens INTEGER NOT NULL DEFAULT 0,
      commits INTEGER NOT NULL DEFAULT 0,
      files INTEGER NOT NULL DEFAULT 0,
      lines_product INTEGER NOT NULL DEFAULT 0,
      lines_test INTEGER NOT NULL DEFAULT 0,
      lines_docs INTEGER NOT NULL DEFAULT 0,
      lines_config INTEGER NOT NULL DEFAULT 0,
      lines_generated INTEGER NOT NULL DEFAULT 0,
      collected_at TEXT NOT NULL
    );
    CREATE TABLE record_ledger (
      table_name TEXT NOT NULL,
      local_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      destination_space_id TEXT,
      PRIMARY KEY (table_name, local_key)
    );
    INSERT INTO day
      (day,claude_tokens,messages,tasks,commits,files,lines_product,collected_at)
    VALUES
      ('2026-10-08',10,2,1,3,4,5,'2026-10-08T12:00:00.000Z'),
      ('2026-10-09',20,4,2,6,8,10,'2026-10-09T12:00:00.000Z');
    INSERT INTO record_ledger (table_name,local_key,content_hash,synced_at)
    VALUES
      ('day','2026-10-08','hash-a','2026-10-08T12:00:00.000Z'),
      ('day','2026-10-09','hash-b','2026-10-09T12:00:00.000Z'),
      ('interval','interval-id','hash-c','2026-10-09T12:00:00.000Z');
  `)

  applyDayRecordIdMigration(database)

  const columns = database
    .query<{ name: string; notnull: number; pk: number }, []>(`PRAGMA table_info(day)`)
    .all()
  expect(columns.find((column) => column.name === 'record_id')).toMatchObject({
    notnull: 1,
    pk: 1,
  })
  const days = database
    .query<{ record_id: string; day: string; claude_tokens: number }, []>(
      `SELECT record_id,day,claude_tokens FROM day ORDER BY day`,
    )
    .all()
  expect(days.map((row) => [row.day, row.claude_tokens])).toEqual([
    ['2026-10-08', 10],
    ['2026-10-09', 20],
  ])
  expect(new Set(days.map((row) => row.record_id)).size).toBe(2)
  expect(
    database
      .query<{ local_key: string }, []>(
        `SELECT local_key FROM record_ledger WHERE table_name='day' ORDER BY local_key`,
      )
      .all()
      .map((row) => row.local_key)
      .sort(),
  ).toEqual(days.map((row) => row.record_id).sort())
  expect(
    database
      .query<{ local_key: string }, []>(
        `SELECT local_key FROM record_ledger WHERE table_name='interval'`,
      )
      .get(),
  ).toEqual({ local_key: 'interval-id' })
  expect(() =>
    database
      .query(
        `INSERT INTO day (record_id,day,collected_at) VALUES ('another-id','2026-10-08','now')`,
      )
      .run(),
  ).toThrow()
  database.close()
})
