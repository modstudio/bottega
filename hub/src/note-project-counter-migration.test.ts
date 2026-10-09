import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_NAME } from '../../shared/brand.ts'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

function storeBeforeProjectCounters() {
  const folder = mkdtempSync(join(tmpdir(), 'hub-note-project-counter-migration-'))
  mkdirSync(join(folder, 'meta'))
  const entries = migrationJournal().slice(0, 22)
  for (const entry of entries)
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries }),
  )
  const database = new Database(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  applyMigrations(database, folder)
  rmSync(folder, { recursive: true, force: true })
  return database
}

test('note project counter migration preserves rows and acknowledgements', () => {
  const d = storeBeforeProjectCounters()
  d.exec(`
    INSERT INTO note(id,record_id,number,project,text,anchors,created_at,last_seen_at)
    VALUES
      (41,'00000000-0000-4000-8000-000000000041',41,'workshop','first','[]','2026-01-01','2026-01-01'),
      (48,'00000000-0000-4000-8000-000000000048',48,'workshop','second','[]','2026-01-01','2026-01-01'),
      (142,'00000000-0000-4000-8000-000000000142',41,'alpha','alpha','[]','2026-01-01','2026-01-01');
  `)
  d.query(`INSERT INTO note_acknowledgement(record_id,note_record_id,session_id,acknowledged_at,sightings)
    VALUES (?,?,?,?,1)`).run(
    '00000000-0000-4000-8000-000000000200',
    '00000000-0000-4000-8000-000000000048',
    'session-a',
    '2026-01-02',
  )
  d.query("INSERT INTO seq(name,next) VALUES ('note',100)").run()

  expect(applyMigrations(d)).toEqual(['0022_note_project_counter'])
  expect(d.query('SELECT project,next FROM note_counter ORDER BY project').all()).toEqual([
    { project: 'alpha', next: 42 },
    { project: PLATFORM_NAME.toLowerCase(), next: 2 },
    { project: 'workshop', next: 49 },
  ])
  expect(
    d.query('SELECT record_id,number,project FROM note ORDER BY project,number').all(),
  ).toHaveLength(4)
  expect(d.query("SELECT 1 FROM seq WHERE name='note'").get()).toBeNull()
  expect(
    d
      .query(`SELECT n.record_id FROM note_acknowledgement a
      JOIN note n ON n.record_id=a.note_record_id WHERE a.session_id='session-a'`)
      .get(),
  ).toEqual({ record_id: '00000000-0000-4000-8000-000000000048' })
  expect(
    d
      .query('PRAGMA table_info(note)')
      .all()
      .map((row) => (row as { name: string }).name),
  ).not.toContain('id')
  d.close()
})
