import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations, applyMigrationsBefore } from './migrations.ts'

const MIGRATION = '0116_release_project_identity'

test('release project identity backfills only an exactly matching project', () => {
  const database = new Database(':memory:')
  applyMigrationsBefore(database, MIGRATION)
  database.exec(`
    INSERT INTO project (record_id,name,path,settings) VALUES
      ('01990000-0000-7000-8000-000000000001','matched','/matched','{}'),
      ('01990000-0000-7000-8000-000000000002','other','/other','{}');
    INSERT INTO release_ledger
      (record_id,project,rung,candidate_commit,rollback,actor,started_at) VALUES
      ('01990000-0000-7000-8000-000000000011','matched','production','one',0,'operator','2026-10-16T00:00:00.000Z'),
      ('01990000-0000-7000-8000-000000000012','unknown','production','two',0,'operator','2026-10-16T00:01:00.000Z');
  `)

  expect(applyMigrations(database)).toContain(MIGRATION)
  expect(
    database
      .query('SELECT project,project_record_id FROM release_ledger ORDER BY started_at,record_id')
      .all(),
  ).toEqual([
    { project: 'matched', project_record_id: '01990000-0000-7000-8000-000000000001' },
    { project: 'unknown', project_record_id: null },
  ])
  expect(database.query("PRAGMA foreign_key_list('release_ledger')").all()).toContainEqual(
    expect.objectContaining({ from: 'project_record_id', table: 'project', to: 'record_id' }),
  )
  database.close()
})
