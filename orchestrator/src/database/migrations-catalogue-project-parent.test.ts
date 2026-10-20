import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations, applyMigrationsBefore } from './migrations.ts'

const TABLES = [
  'project_lens_profile',
  'project_lens_profile_revision',
  'port_pair',
  'port_baseline',
  'port_skip',
  'port_ref',
  'port_ref_source',
] as const

test('catalogue project-parent removal preserves populated rows, ids, and catalogue parents', () => {
  const database = new Database(':memory:')
  database.exec('PRAGMA foreign_keys=ON')
  applyMigrationsBefore(database, '0129_catalogue_projects_without_local_parent')

  const source = newRecordId()
  const target = newRecordId()
  const selectionRecord = newRecordId()
  const pairRecord = newRecordId()
  const refRecord = newRecordId()
  database
    .query(
      "INSERT INTO project (record_id,name,path,canon,settings) VALUES (?,'source','/source',1,'{}'),(?,'target','/target',1,'{}')",
    )
    .run(source, target)
  database
    .query(
      `INSERT INTO project_lens_profile
       (id,project_record_id,lens_id,axis,profile_name,selected_version,record_id,selection_version,space_id)
       VALUES (41,?,NULL,'framework','default',NULL,?,1,NULL)`,
    )
    .run(target, selectionRecord)
  database
    .query(
      `INSERT INTO project_lens_profile_revision
       (id,selection_id,prior_profile_name,prior_selected_version,reason,session_id,at,record_id,space_id)
       VALUES (42,41,NULL,NULL,'test',NULL,'2026-10-19T00:00:00.000Z',?,NULL)`,
    )
    .run(newRecordId())
  database
    .query(
      `INSERT INTO port_pair
       (id,source_project_record_id,target_project_record_id,created_at,record_id,space_id)
       VALUES (43,?,?,'2026-10-19T00:00:00.000Z',?,NULL)`,
    )
    .run(source, target, pairRecord)
  database
    .query(
      `INSERT INTO port_baseline (pair_id,source_commit,scanned_at,record_id,version,space_id)
       VALUES (43,NULL,NULL,?,1,NULL)`,
    )
    .run(newRecordId())
  database
    .query(
      `INSERT INTO port_skip (id,pair_id,candidate,reason,skipped_at,record_id,space_id)
       VALUES (44,43,'candidate','test','2026-10-19T00:00:00.000Z',?,NULL)`,
    )
    .run(newRecordId())
  database
    .query(
      `INSERT INTO port_ref
       (task_key,target_project_record_id,note,created_at,resolved_at,record_id,version,space_id)
       VALUES ('DEV-1404',?,'test','2026-10-19T00:00:00.000Z',NULL,?,1,NULL)`,
    )
    .run(target, refRecord)
  database
    .query(
      `INSERT INTO port_ref_source
       (id,task_key,target_project_record_id,source_project_record_id,commits,paths,note,record_id,space_id)
       VALUES (45,'DEV-1404',?,?,'[]','[]','test',?,NULL)`,
    )
    .run(target, source, newRecordId())

  const before = Object.fromEntries(
    TABLES.map((table) => [table, database.query(`SELECT COUNT(*) AS n FROM ${table}`).get()]),
  )
  applyMigrations(database)

  expect(
    Object.fromEntries(
      TABLES.map((table) => [table, database.query(`SELECT COUNT(*) AS n FROM ${table}`).get()]),
    ),
  ).toEqual(before)
  expect(database.query('SELECT record_id FROM project_lens_profile').get()).toEqual({
    record_id: selectionRecord,
  })
  expect(database.query('SELECT record_id FROM port_pair').get()).toEqual({
    record_id: pairRecord,
  })
  expect(database.query('SELECT position FROM port_ref_source').get()).toEqual({ position: 1 })
  for (const table of ['port_pair', 'port_ref'])
    expect(database.query(`PRAGMA foreign_key_list(${table})`).all()).toEqual([])
  expect(database.query('PRAGMA foreign_key_list(port_ref_source)').all()).toEqual(
    expect.not.arrayContaining([expect.objectContaining({ table: 'project' })]),
  )
  expect(database.query('PRAGMA foreign_key_list(port_ref_source)').all()).toEqual(
    expect.arrayContaining([expect.objectContaining({ table: 'port_ref', on_delete: 'CASCADE' })]),
  )
  expect(database.query('PRAGMA foreign_key_list(project_lens_profile_revision)').all()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ table: 'project_lens_profile', on_delete: 'CASCADE' }),
    ]),
  )
  expect(database.query('PRAGMA foreign_key_list(port_baseline)').all()).toEqual(
    expect.arrayContaining([expect.objectContaining({ table: 'port_pair', on_delete: 'CASCADE' })]),
  )
  expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
})
