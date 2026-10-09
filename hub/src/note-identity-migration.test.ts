import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

function storeBeforeNoteIdentity() {
  const folder = mkdtempSync(join(tmpdir(), 'hub-note-identity-migration-'))
  mkdirSync(join(folder, 'meta'))
  const entries = migrationJournal().slice(0, 21)
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

test('note UUID migration preserves notes and acknowledgements', () => {
  const d = storeBeforeNoteIdentity()
  d.exec(`
    INSERT INTO note(id,record_id,project,text,anchors,sightings,created_at,last_seen_at)
    VALUES (41,NULL,'workshop','first','[]',1,'2026-01-01','2026-01-01'),
           (42,'00000000-0000-4000-8000-000000000042','alpha','second','[]',1,'2026-01-01','2026-01-01');
    INSERT INTO note_acknowledgement(note_id,session_id,acknowledged_at,sightings,record_id)
    VALUES (41,'session-a','2026-01-02',1,NULL),
           (42,'session-b','2026-01-02',1,'00000000-0000-4000-8000-000000000142');
  `)
  expect(applyMigrations(d)).toEqual(['0021_note_uuid_identity', '0022_note_project_counter'])
  expect(
    d
      .query<{ number: number; record_id: string }, []>(
        'SELECT number,record_id FROM note WHERE number >= 41 ORDER BY number',
      )
      .all(),
  ).toEqual([
    { number: 41, record_id: expect.any(String) },
    { number: 42, record_id: '00000000-0000-4000-8000-000000000042' },
  ])
  expect(
    d
      .query<{ session_id: string; note_record_id: string }, []>(
        'SELECT session_id,note_record_id FROM note_acknowledgement ORDER BY session_id',
      )
      .all(),
  ).toEqual([
    { session_id: 'session-a', note_record_id: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    { session_id: 'session-b', note_record_id: '00000000-0000-4000-8000-000000000042' },
  ])
  const acknowledgementColumns = d
    .query<{ name: string }, []>('PRAGMA table_info(note_acknowledgement)')
    .all()
    .map((row) => row.name)
  expect(acknowledgementColumns).not.toContain('note_id')
  expect(() =>
    d.exec(`INSERT INTO note(record_id,number,project,text,anchors,created_at,last_seen_at)
      VALUES ('00000000-0000-4000-8000-000000000043',42,'alpha','duplicate','[]','2026-01-01','2026-01-01')`),
  ).toThrow('UNIQUE constraint failed: note.project, note.number')
  d.close()
})
