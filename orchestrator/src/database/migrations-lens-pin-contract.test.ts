import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations, applyMigrationsBefore } from './migrations.ts'

const MIGRATION = '0192_lens_profile_pin_contract'

function beforeContract(): Database {
  const database = new Database(':memory:')
  applyMigrationsBefore(database, MIGRATION)
  return database
}

function insertLensProfile(
  database: Database,
  spaceId: string | null,
): {
  lensId: string
  profileId: string
} {
  const lensId = newRecordId(),
    profileId = newRecordId()
  database
    .query(
      `INSERT INTO lens
       (record_id,id,title,question,excludes,slots,version,enabled,requires_execution,space_id)
       VALUES (?,'contract-lens','Contract lens','Question?','Nothing.','{}',1,1,0,?)`,
    )
    .run(lensId, spaceId)
  database
    .query(
      `INSERT INTO lens_profile
       (record_id,lens_record_id,axis,name,version,current_version_id,body,enabled,space_id)
       VALUES (?,?,'framework','default',1,?,'{}',1,?)`,
    )
    .run(profileId, lensId, newRecordId(), spaceId)
  return { lensId, profileId }
}

test('lens pin contract permits an unpinned selection and contracts integer columns', () => {
  const database = beforeContract()
  const { lensId, profileId } = insertLensProfile(database, null)
  database
    .query(
      `INSERT INTO lens_profile_revision
       (record_id,profile_record_id,version,prior_body,reason,at)
       VALUES (?,?,0,'{}','contract fixture','2026-01-01T00:00:00.000Z')`,
    )
    .run(newRecordId(), profileId)
  database
    .query(
      `INSERT INTO project_lens_profile
       (record_id,project_record_id,lens_record_id,axis,profile_name,selected_version,selected_version_id,selection_version)
       VALUES (?,?,?,'framework','default',NULL,NULL,1)`,
    )
    .run(newRecordId(), newRecordId(), lensId)

  expect(applyMigrations(database)).toContain(MIGRATION)
  expect(
    database
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('project_lens_profile')")
      .all()
      .map((column) => column.name),
  ).not.toContain('selected_version')
  expect(
    database
      .query<{ name: string; required: number }, []>(
        `SELECT name,"notnull" required FROM pragma_table_info('lens_profile')
         WHERE name='current_version_id'`,
      )
      .get(),
  ).toEqual({ name: 'current_version_id', required: 1 })
  expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
})

test('lens pin contract refuses a cached integer-only pin with the cache-pull remedy', () => {
  const database = beforeContract(),
    spaceId = newRecordId(),
    { lensId } = insertLensProfile(database, spaceId)
  database
    .query(
      `INSERT INTO project_lens_profile
       (record_id,project_record_id,lens_record_id,axis,profile_name,selected_version,selected_version_id,selection_version,space_id)
       VALUES (?,?,?,'framework','default',99,NULL,1,?)`,
    )
    .run(newRecordId(), newRecordId(), lensId, spaceId)

  expect(() => applyMigrations(database)).toThrow(
    new RegExp(
      `unresolved project_lens_profile=1 project_lens_profile_revision=0; lens_profile\\.current_version_id NULL=0[\\s\\S]*space-cached rows=1[\\s\\S]*${PLATFORM_SLUG} record pull`,
    ),
  )
})
