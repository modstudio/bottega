import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrationsBefore } from './migrations.ts'

const MIGRATION = '0190_lens_profile_selected_version_id'
const CONTRACT = '0192_lens_profile_pin_contract'

test('lens pin migration resolves current and prior versions without guessing', () => {
  const database = new Database(':memory:')
  applyMigrationsBefore(database, MIGRATION)
  const lensId = newRecordId()
  const profileId = newRecordId()
  const currentVersionId = newRecordId()
  const priorVersionId = newRecordId()
  database
    .query(
      `INSERT INTO lens (record_id,id,title,question,excludes,slots,version,enabled,requires_execution)
       VALUES (?,'migration-pin','Migration pin','Question?','Nothing.','{}',1,1,0)`,
    )
    .run(lensId)
  database
    .query(
      `INSERT INTO lens_profile (record_id,lens_record_id,axis,name,version,current_version_id,body,enabled)
       VALUES (?,?,'framework','default',2,?,'{}',1)`,
    )
    .run(profileId, lensId, currentVersionId)
  database
    .query(
      `INSERT INTO lens_profile_revision (record_id,profile_record_id,version,prior_body,reason,at)
       VALUES (?,?,1,'{"body":{},"enabled":true}','prior fixture','2026-01-01T00:00:00.000Z')`,
    )
    .run(priorVersionId, profileId)

  const selections = [
    { id: newRecordId(), project: newRecordId(), version: 2 },
    { id: newRecordId(), project: newRecordId(), version: 1 },
    { id: newRecordId(), project: newRecordId(), version: 99 },
  ]
  for (const selection of selections)
    database
      .query(
        `INSERT INTO project_lens_profile
         (record_id,project_record_id,lens_record_id,axis,profile_name,selected_version,selection_version)
         VALUES (?,?,?,'framework','default',?,1)`,
      )
      .run(selection.id, selection.project, lensId, selection.version)
  database
    .query(
      `INSERT INTO project_lens_profile_revision
       (record_id,selection_record_id,prior_profile_name,prior_selected_version,reason,at)
       VALUES (?,?, 'default',1,'history fixture','2026-01-01T00:00:00.000Z')`,
    )
    .run(newRecordId(), selections[0]!.id)

  expect(applyMigrationsBefore(database, CONTRACT)).toContain(MIGRATION)
  expect(
    database
      .query<{ selected_version_id: string | null }, []>(
        'SELECT selected_version_id FROM project_lens_profile ORDER BY selected_version',
      )
      .all(),
  ).toEqual([
    { selected_version_id: priorVersionId },
    { selected_version_id: currentVersionId },
    { selected_version_id: null },
  ])
  expect(
    database
      .query<{ prior_selected_version_id: string | null }, []>(
        'SELECT prior_selected_version_id FROM project_lens_profile_revision',
      )
      .get(),
  ).toEqual({ prior_selected_version_id: priorVersionId })
})

test('lens pin backfill preserves an id it cannot resolve when migrations run again', () => {
  const database = new Database(':memory:')
  applyMigrationsBefore(database, CONTRACT)
  const lensId = newRecordId()
  const profileId = newRecordId()
  const selectedVersionId = newRecordId()
  database
    .query(
      `INSERT INTO lens (record_id,id,title,question,excludes,slots,version,enabled,requires_execution)
       VALUES (?,'migration-rerun','Migration rerun','Question?','Nothing.','{}',1,1,0)`,
    )
    .run(lensId)
  database
    .query(
      `INSERT INTO lens_profile (record_id,lens_record_id,axis,name,version,current_version_id,body,enabled)
       VALUES (?,?,'framework','default',2,?,'{}',1)`,
    )
    .run(profileId, lensId, newRecordId())
  database
    .query(
      `INSERT INTO project_lens_profile
       (record_id,project_record_id,lens_record_id,axis,profile_name,selected_version,selected_version_id,selection_version)
       VALUES (?,?,?,'framework','default',99,?,1)`,
    )
    .run(newRecordId(), newRecordId(), lensId, selectedVersionId)

  applyMigrationsBefore(database, CONTRACT)

  expect(
    database
      .query<{ selected_version_id: string }, []>(
        'SELECT selected_version_id FROM project_lens_profile',
      )
      .get(),
  ).toEqual({ selected_version_id: selectedVersionId })
})
