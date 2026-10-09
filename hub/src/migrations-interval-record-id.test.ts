import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MIGRATIONS_FOLDER, stripSqlComments } from './migrations.ts'

function applyIntervalRecordIdMigration(database: Database) {
  const source = readFileSync(join(MIGRATIONS_FOLDER, '0019_interval_record_id.sql'), 'utf8')
  for (const statement of source.split('--> statement-breakpoint')) {
    const sql = stripSqlComments(statement).trim()
    if (sql) database.exec(sql)
  }
}

test('interval UUID rebuild preserves rows, rewrites matching ledger keys, and leaves unmatched keys', () => {
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE interval (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_key TEXT,
      project TEXT,
      source TEXT NOT NULL CHECK (source IN ('claude','codex','orch')),
      agent TEXT,
      job TEXT,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      claude_tokens INTEGER NOT NULL DEFAULT 0,
      vendor_tokens INTEGER NOT NULL DEFAULT 0,
      vendor_cost_usd REAL,
      ref TEXT NOT NULL,
      via TEXT,
      open INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      user_id TEXT,
      CHECK (end_at >= start_at)
    );
    CREATE UNIQUE INDEX interval_once ON interval(source, ref, start_at);
    CREATE INDEX interval_span ON interval(start_at, end_at);
    CREATE INDEX interval_task ON interval(task_key, start_at);
    CREATE TABLE record_ledger (
      table_name TEXT NOT NULL,
      local_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      destination_space_id TEXT,
      PRIMARY KEY (table_name, local_key)
    );
    INSERT INTO interval
      (task_key,project,source,agent,job,start_at,end_at,claude_tokens,vendor_tokens,ref,open)
    VALUES
      ('DEV-1','workshop','claude',NULL,NULL,'2026-10-08T10:00:00.000Z','2026-10-08T10:05:00.000Z',1,0,'claude:a:0',0),
      ('DEV-2','workshop','orch','codex','implement','2026-10-08T11:00:00.000Z','2026-10-08T11:05:00.000Z',0,2,'orch:9',1);
    INSERT INTO record_ledger
      (table_name,local_key,content_hash,synced_at,destination_space_id)
    VALUES
      ('interval','["claude","claude:a:0","2026-10-08T10:00:00.000Z"]','hash-a','2026-10-01T00:00:00.000Z','space-a'),
      ('interval','["orch","orch:9","2026-10-08T11:00:00.000Z"]','hash-b','2026-10-01T00:00:00.000Z','space-b'),
      ('interval','["claude","claude:gone:0","2026-10-08T09:00:00.000Z"]','hash-gone','2026-10-01T00:00:00.000Z','space-a'),
      ('day','2026-10-08','hash-day','2026-10-01T00:00:00.000Z',NULL);
  `)

  applyIntervalRecordIdMigration(database)

  const columns = database
    .query<{ name: string; notnull: number; pk: number }, []>(`PRAGMA table_info(interval)`)
    .all()
  expect(columns.some((column) => column.name === 'id')).toBe(false)
  expect(columns.find((column) => column.name === 'record_id')).toMatchObject({
    notnull: 1,
    pk: 1,
  })
  const intervals = database
    .query<{ record_id: string; source: string; ref: string; start_at: string }, []>(
      `SELECT record_id, source, ref, start_at FROM interval ORDER BY start_at`,
    )
    .all()
  expect(intervals).toHaveLength(2)
  expect(new Set(intervals.map((row) => row.record_id)).size).toBe(2)
  expect(intervals.every((row) => row.record_id.includes('-'))).toBe(true)

  const ledger = database
    .query<
      { local_key: string; destination_space_id: string | null; table_name: string },
      []
    >(`SELECT table_name, local_key, destination_space_id FROM record_ledger ORDER BY table_name, local_key`)
    .all()
  const intervalLedger = ledger.filter((row) => row.table_name === 'interval')
  const matchedClaude = intervalLedger.find(
    (row) => row.local_key === intervals[0]!.record_id,
  )
  const matchedOrch = intervalLedger.find((row) => row.local_key === intervals[1]!.record_id)
  expect(matchedClaude).toEqual({
    table_name: 'interval',
    local_key: intervals[0]!.record_id,
    destination_space_id: 'space-a',
  })
  expect(matchedOrch).toEqual({
    table_name: 'interval',
    local_key: intervals[1]!.record_id,
    destination_space_id: 'space-b',
  })
  expect(
    intervalLedger.find(
      (row) => row.local_key === '["claude","claude:gone:0","2026-10-08T09:00:00.000Z"]',
    ),
  ).toEqual({
    table_name: 'interval',
    local_key: '["claude","claude:gone:0","2026-10-08T09:00:00.000Z"]',
    destination_space_id: 'space-a',
  })
  expect(ledger.find((row) => row.table_name === 'day')).toEqual({
    table_name: 'day',
    local_key: '2026-10-08',
    destination_space_id: null,
  })
  expect(() =>
    database
      .query(
        `INSERT INTO interval (record_id,source,start_at,end_at,ref)
         VALUES ('dup','claude','2026-10-08T10:00:00.000Z','2026-10-08T10:01:00.000Z','claude:a:0')`,
      )
      .run(),
  ).toThrow()
  database.close()
})
