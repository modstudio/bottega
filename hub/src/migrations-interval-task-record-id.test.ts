import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HUB_MIGRATION_BACKFILL_VALUES } from '../test/migration-values.ts'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

const REMEDY =
  'an interval must reference a task or a project; register the project or use a task key that resolves to exactly one task'

function migratedBeforeIntervalLink() {
  const folder = mkdtempSync(join(tmpdir(), 'hub-interval-task-link-'))
  mkdirSync(join(folder, 'meta'))
  const entries = migrationJournal().slice(0, 40)
  for (const entry of entries)
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries }),
  )
  const database = new Database(':memory:')
  database.exec('PRAGMA foreign_keys=ON')
  applyMigrations(database, folder, HUB_MIGRATION_BACKFILL_VALUES)
  rmSync(folder, { recursive: true, force: true })
  return database
}

test('interval task migration backfills only unique keys and leaves legacy linkless rows', () => {
  const d = migratedBeforeIntervalLink()
  try {
    d.exec(`
      INSERT INTO task(record_id,key,project,source,first_seen,last_seen) VALUES
        ('task-match','MATCH-1','alpha','local','2026-10-25','2026-10-25'),
        ('task-dup-a','DUP-1','alpha','local','2026-10-25','2026-10-25'),
        ('task-dup-b','DUP-1','beta','local','2026-10-25','2026-10-25');
      INSERT INTO interval(record_id,task_key,source,start_at,end_at,ref) VALUES
        ('interval-match','MATCH-1','orch','2026-10-25','2026-10-25','match'),
        ('interval-missing','MISSING-1','orch','2026-10-25','2026-10-25','missing'),
        ('interval-duplicate','DUP-1','orch','2026-10-25','2026-10-25','duplicate');
      INSERT INTO interval(record_id,project_record_id,source,start_at,end_at,ref)
        VALUES ('interval-project','project-id','orch','2026-10-25','2026-10-25','project');
      INSERT INTO interval(record_id,source,start_at,end_at,ref)
        VALUES ('interval-legacy','orch','2026-10-25','2026-10-25','legacy');
    `)
    expect(applyMigrations(d, undefined, HUB_MIGRATION_BACKFILL_VALUES)).toContain(
      '0040_interval_task_record_id',
    )
    expect(
      d.query(`SELECT record_id,task_record_id FROM interval ORDER BY record_id`).all(),
    ).toEqual([
      { record_id: 'interval-duplicate', task_record_id: null },
      { record_id: 'interval-legacy', task_record_id: null },
      { record_id: 'interval-match', task_record_id: 'task-match' },
      { record_id: 'interval-missing', task_record_id: null },
      { record_id: 'interval-project', task_record_id: null },
    ])
  } finally {
    d.close()
  }
})

test('interval link triggers enforce new writes and attach intervals when their task arrives', () => {
  const d = migratedBeforeIntervalLink()
  try {
    applyMigrations(d, undefined, HUB_MIGRATION_BACKFILL_VALUES)
    expect(() =>
      d.exec(
        `INSERT INTO interval(record_id,source,start_at,end_at,ref)
         VALUES ('refused','orch','2026-10-25','2026-10-25','refused')`,
      ),
    ).toThrow(REMEDY)
    d.exec(`
      INSERT INTO interval(record_id,task_key,project_record_id,source,start_at,end_at,ref)
      VALUES ('late','LATE-1','project-id','orch','2026-10-25','2026-10-25','late');
      INSERT INTO task(record_id,key,project,source,first_seen,last_seen)
      VALUES ('task-late','LATE-1','alpha','local','2026-10-25','2026-10-25');
      INSERT INTO interval(record_id,task_record_id,source,start_at,end_at,ref)
      VALUES ('linked','task-late','orch','2026-10-25','2026-10-25','linked');
      INSERT INTO interval(record_id,project_record_id,source,start_at,end_at,ref)
      VALUES ('project','project-id','orch','2026-10-25','2026-10-25','project');
    `)
    expect(d.query(`SELECT task_record_id FROM interval WHERE record_id='late'`).get()).toEqual({
      task_record_id: 'task-late',
    })
  } finally {
    d.close()
  }
})
