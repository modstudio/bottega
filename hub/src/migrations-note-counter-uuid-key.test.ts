import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { HUB_MIGRATION_BACKFILL_VALUES } from '../test/migration-values.ts'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

const MIGRATION = '0039_note_counter_uuid_key'

function beforeNoteCounterRekey(): Database {
  const folder = mkdtempSync(join(tmpdir(), 'hub-note-counter-migration-stage-'))
  mkdirSync(join(folder, 'meta'))
  const entries = migrationJournal().slice(0, 39)
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

test('keys note counters by UUID without losing their values', () => {
  const database = beforeNoteCounterRekey()
  try {
    database.exec(`
      DELETE FROM note_counter;
      INSERT INTO note_counter(project,next,project_record_id) VALUES
        ('alpha',7,'01990000-0000-7000-8000-000000001901'),
        ('beta',11,NULL);
    `)
    expect(applyMigrations(database, undefined, HUB_MIGRATION_BACKFILL_VALUES)).toContain(MIGRATION)
    const rows = database
      .query<
        { record_id: string; project: string; next: number; project_record_id: string | null },
        []
      >('SELECT * FROM note_counter ORDER BY project')
      .all()
    expect(rows.map(({ record_id: _recordId, ...row }) => row)).toEqual([
      { project: 'alpha', next: 7, project_record_id: '01990000-0000-7000-8000-000000001901' },
      { project: 'beta', next: 11, project_record_id: null },
    ])
    expect(rows.every((row) => row.record_id.length > 0)).toBe(true)
    expect(new Set(rows.map((row) => row.record_id)).size).toBe(2)
    expect(() =>
      database.exec(
        `INSERT INTO note_counter(record_id,project,next) VALUES ('01990000-0000-7000-8000-000000001902','alpha',12)`,
      ),
    ).toThrow('UNIQUE constraint failed: note_counter.project')
  } finally {
    database.close()
  }
})

test('refuses a NULL project with the migration remedy', () => {
  const database = beforeNoteCounterRekey()
  try {
    database.exec(`
      DELETE FROM note_counter;
      INSERT INTO note_counter(project,next,project_record_id) VALUES (NULL,7,NULL);
    `)
    expect(() => applyMigrations(database, undefined, HUB_MIGRATION_BACKFILL_VALUES)).toThrow(
      'note_counter.project is NULL or empty for rows [rowid=1 project=<NULL>]\n' +
        `cleared by: repair the named note counters, then run \`${PLATFORM_SLUG} machine migrate\``,
    )
    expect(database.query('SELECT project,next FROM note_counter').get()).toEqual({
      project: null,
      next: 7,
    })
  } finally {
    database.close()
  }
})
