import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

test('project identity migration preserves rows and adds a nullable unique hosted id', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-project-record-identity-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const migration = journal.findIndex((entry) => entry.tag === '0112_project_record_identity')
  const prior = journal.slice(0, migration)
  for (const entry of prior) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  }
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries: prior }),
  )
  const database = new Database(':memory:')
  try {
    applyMigrations(database, folder)
    database.query("INSERT INTO project (name,path,settings) VALUES ('one','/one','{}')").run()
    expect(applyMigrations(database)).toContain('0112_project_record_identity')
    expect(database.query("SELECT record_id FROM project WHERE name='one'").get()).toEqual({
      record_id: null,
    })
    const id = newRecordId()
    database.query('UPDATE project SET record_id=? WHERE name=?').run(id, 'one')
    database.query("INSERT INTO project (name,path,settings) VALUES ('two','/two','{}')").run()
    expect(() =>
      database.query('UPDATE project SET record_id=? WHERE name=?').run(id, 'two'),
    ).toThrow()
  } finally {
    database.close()
    rmSync(folder, { recursive: true, force: true })
  }
})
