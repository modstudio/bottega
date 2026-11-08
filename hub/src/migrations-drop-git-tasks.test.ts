import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HUB_MIGRATION_BACKFILL_VALUES } from '../test/migration-values.ts'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

const migrationTag = '0047_drop_git_tasks'

function migratedBeforeDrop(): Database {
  const folder = mkdtempSync(join(tmpdir(), 'hub-git-task-migration-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const entries = journal.slice(
    0,
    journal.findIndex((entry) => entry.tag === migrationTag),
  )
  for (const entry of entries)
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries }),
  )
  const database = new Database(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  applyMigrations(database, folder, HUB_MIGRATION_BACKFILL_VALUES)
  rmSync(folder, { recursive: true, force: true })
  return database
}

test('tracker-only task migration deletes git status history and preserves tracker history', () => {
  const database = migratedBeforeDrop()
  database.exec(`
    INSERT INTO task(record_id,key,project,source,first_seen,last_seen) VALUES
      ('git-task','DEV-1','workshop','git','2026-01-01','2026-01-01'),
      ('mcp-task','DEV-2','workshop','mcp','2026-01-01','2026-01-01');
    INSERT INTO task_status_event(record_id,task_key,task_record_id,at,to_status) VALUES
      ('git-event','DEV-1','git-task','2026-01-01','open'),
      ('mcp-event','DEV-2','mcp-task','2026-01-01','open');
  `)

  expect(applyMigrations(database, undefined, HUB_MIGRATION_BACKFILL_VALUES)).toEqual([
    migrationTag,
  ])
  expect(database.query('SELECT record_id FROM task ORDER BY record_id').all()).toEqual([
    { record_id: 'mcp-task' },
  ])
  expect(
    database.query('SELECT record_id FROM task_status_event ORDER BY record_id').all(),
  ).toEqual([{ record_id: 'mcp-event' }])
  database.close()
})

for (const [kind, insert, refusal] of [
  [
    'comment',
    `INSERT INTO task_comment(record_id,task_key,task_record_id,body,created_at)
     VALUES ('git-comment','DEV-1','git-task','keep me','2026-01-01')`,
    'task_comment:git-comment',
  ],
  [
    'document',
    `INSERT INTO task_document(record_id,task_key,task_record_id,number,title,body,version,created_at,updated_at)
     VALUES ('git-document','DEV-1','git-task',1,'keep me','body','v1','2026-01-01','2026-01-01')`,
    'task_document:git-document',
  ],
] as const) {
  test(`tracker-only task migration still refuses a git task ${kind}`, () => {
    const database = migratedBeforeDrop()
    database.exec(`
      INSERT INTO task(record_id,key,project,source,first_seen,last_seen)
      VALUES ('git-task','DEV-1','workshop','git','2026-01-01','2026-01-01');
      ${insert};
    `)

    expect(() => applyMigrations(database, undefined, HUB_MIGRATION_BACKFILL_VALUES)).toThrow(
      `git task rows have cascade dependents: ${refusal}`,
    )
    expect(database.query("SELECT record_id FROM task WHERE source='git'").all()).toEqual([
      { record_id: 'git-task' },
    ])
    database.close()
  })
}
