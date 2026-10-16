import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { applyMigrations, applyMigrationsBefore } from './migrations.ts'

function journal(folder: string, entries: Array<{ tag: string; sql: string }>): void {
  mkdirSync(join(folder, 'meta'))
  for (const entry of entries) writeFileSync(join(folder, `${entry.tag}.sql`), entry.sql)
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'sqlite',
      entries: entries.map((entry, idx) => ({
        idx,
        version: '6',
        when: idx + 1,
        tag: entry.tag,
        breakpoints: true,
      })),
    }),
  )
}

const baseline = `
CREATE TABLE project (id INTEGER PRIMARY KEY, record_id TEXT);
CREATE TABLE child (id INTEGER PRIMARY KEY, project_id INTEGER REFERENCES project(id));`

test('a parent rebuild preserves every child project_id', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-project-rebuild-'))
  journal(folder, [
    { tag: '0000_base', sql: baseline },
    {
      tag: '0001_contract',
      sql: `-- REBUILD WITH FOREIGN KEYS OFF
CREATE TABLE project_next (id INTEGER PRIMARY KEY, record_id TEXT NOT NULL UNIQUE);
INSERT INTO project_next SELECT * FROM project;
DROP TABLE project;
ALTER TABLE project_next RENAME TO project;`,
    },
  ])
  const database = new Database(':memory:')
  database.exec('PRAGMA foreign_keys=ON')
  applyMigrationsBefore(database, '0001_contract', folder)
  database.exec("INSERT INTO project VALUES (7, '01990000-0000-7000-8000-000000001214')")
  database.exec('INSERT INTO child VALUES (1, 7)')
  applyMigrations(database, folder)
  expect(database.query('SELECT project_id FROM child').get()).toEqual({ project_id: 7 })
  expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
})

test('a migration that leaves a dangling reference is refused with its location', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-dangling-migration-'))
  journal(folder, [
    { tag: '0000_base', sql: baseline },
    { tag: '0001_break', sql: '-- REBUILD WITH FOREIGN KEYS OFF\nDELETE FROM project;' },
  ])
  const database = new Database(':memory:')
  database.exec('PRAGMA foreign_keys=ON')
  applyMigrationsBefore(database, '0001_break', folder)
  database.exec("INSERT INTO project VALUES (7, '01990000-0000-7000-8000-000000001214')")
  database.exec('INSERT INTO child VALUES (1, 7)')
  expect(() => applyMigrations(database, folder)).toThrow(
    'table child, rowid 1, parent project, fkid 0',
  )
  expect(database.query('SELECT id FROM project').get()).toEqual({ id: 7 })
  expect(database.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
})

test('the project identity contract refuses a missing id with the fill remedy', () => {
  const database = new Database(':memory:')
  applyMigrationsBefore(database, '0115_project_identity_contract')
  database.exec("INSERT INTO project (name,path,settings) VALUES ('missing','/missing','{}')")
  expect(() => applyMigrations(database)).toThrow(`${PLATFORM_SLUG} project fill-record-ids`)
  expect(database.query('SELECT name,record_id FROM project').get()).toEqual({
    name: 'missing',
    record_id: null,
  })
})

test('the project identity contract backfills run ids and migrates board adoption keys', () => {
  const database = new Database(':memory:')
  database.exec('PRAGMA foreign_keys=ON')
  applyMigrationsBefore(database, '0115_project_identity_contract')
  const projectRecordId = '01990000-0000-7000-8000-000000001210'
  const messageRecordId = '01990000-0000-7000-8000-000000001211'
  database
    .query(
      `INSERT INTO project (record_id,name,path,canon,settings)
       VALUES (?,'known','/known',1,'{}')`,
    )
    .run(projectRecordId)
  database.exec(`
    INSERT INTO run
      (started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,record_id)
    VALUES
      ('2026-10-15','codex','implement','known','sha',1,'p','ok',
       '01990000-0000-7000-8000-000000001212'),
      ('2026-10-15','codex','implement','missing','sha',1,'p','ok',
       '01990000-0000-7000-8000-000000001213');
  `)
  database
    .query(
      `INSERT INTO board_message
       (kind,author_kind,author_session,audience,title,body,ack_required,expires_at,created_at,record_id)
       VALUES ('notice','architect','session','session:reader','title','body',0,
               '2026-10-16','2026-10-15',?)`,
    )
    .run(messageRecordId)
  database.exec(`
    INSERT INTO board_receipt
      (message_id,reader_session,audience_at_posting,delivered_at,record_id)
    VALUES (1,'reader',1,'2026-10-15','01990000-0000-7000-8000-000000001214');
    INSERT INTO board_hosted_adoption_ledger
      (local_kind,local_id,hosted_id,state,refusal,created_at,updated_at,record_id)
    VALUES ('notice',1,'${messageRecordId}','uploaded',NULL,'2026-10-15','2026-10-15',
            '01990000-0000-7000-8000-000000001215');
    INSERT INTO board_hosted_adoption_receipt
      (local_message_id,reader_session,state,refusal,updated_at,record_id)
    VALUES (1,'reader','uploaded',NULL,'2026-10-15',
            '01990000-0000-7000-8000-000000001216');
  `)

  applyMigrations(database)

  expect(database.query('SELECT repo,project_id FROM run ORDER BY id').all()).toEqual([
    { repo: 'known', project_id: 1 },
    { repo: 'missing', project_id: null },
  ])
  expect(database.query('SELECT * FROM board_hosted_adoption_ledger').get()).toMatchObject({
    source_record_id: messageRecordId,
    local_kind: 'notice',
    state: 'uploaded',
  })
  expect(database.query('SELECT * FROM board_hosted_adoption_receipt').get()).toMatchObject({
    message_record_id: messageRecordId,
    reader_session: 'reader',
    state: 'uploaded',
  })
  expect(database.query('PRAGMA table_info(project)').all()).toContainEqual(
    expect.objectContaining({ name: 'record_id', notnull: 1 }),
  )
})

