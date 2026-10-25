import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const MIGRATION = '0162_superseded_workflow_versions'

test('workflow supersession migration preserves prior rows and permits one retired identity twin', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  try {
    const workflowId = newRecordId(),
      workflowVersionId = newRecordId(),
      catalogueId = newRecordId(),
      catalogueVersionId = newRecordId()
    database
      .query('INSERT INTO workflow(record_id,slug,created_at) VALUES (?,?,?)')
      .run(workflowId, 'migration-workflow', '2026-10-25T00:00:00.000Z')
    database
      .query(
        `INSERT INTO workflow_version
         (record_id,workflow_record_id,n,status,definition,author,reason,created_at,promoted_at)
         VALUES (?,?,1,'production','{}','test','test','2026-10-25T00:00:00.000Z','2026-10-25T00:00:00.000Z')`,
      )
      .run(workflowVersionId, workflowId)
    database
      .query('INSERT INTO step_catalogue(record_id,slug,created_at) VALUES (?,?,?)')
      .run(catalogueId, 'migration-catalogue', '2026-10-25T00:00:00.000Z')
    database
      .query(
        `INSERT INTO step_catalogue_version
         (record_id,catalogue_record_id,n,status,definition,author,reason,created_at,promoted_at)
         VALUES (?,?,1,'production','{}','test','test','2026-10-25T00:00:00.000Z','2026-10-25T00:00:00.000Z')`,
      )
      .run(catalogueVersionId, catalogueId)
    const before = {
      workflows: database.query('SELECT COUNT(*) count FROM workflow_version').get(),
      catalogues: database.query('SELECT COUNT(*) count FROM step_catalogue_version').get(),
    }

    expect(applyMigrations(database)).toContain(MIGRATION)
    expect(database.query('SELECT COUNT(*) count FROM workflow_version').get()).toEqual(
      before.workflows,
    )
    expect(database.query('SELECT COUNT(*) count FROM step_catalogue_version').get()).toEqual(
      before.catalogues,
    )
    expect(
      database
        .query('SELECT COUNT(*) count FROM workflow_version WHERE superseded_at IS NOT NULL')
        .get(),
    ).toEqual({ count: 0 })
    expect(
      database
        .query('SELECT COUNT(*) count FROM step_catalogue_version WHERE superseded_at IS NOT NULL')
        .get(),
    ).toEqual({ count: 0 })

    for (const [table, foreign] of [
      ['workflow_version', 'workflow_record_id'],
      ['step_catalogue_version', 'catalogue_record_id'],
    ] as const) {
      const source = database.query(`SELECT * FROM ${table} LIMIT 1`).get() as Record<
        string,
        unknown
      >
      const supersededId = newRecordId()
      database
        .query(
          `INSERT INTO ${table}
           (record_id,${foreign},n,status,definition,author,reason,created_at,promoted_at,retired_at,space_id,superseded_at)
           SELECT ?,${foreign},n,status,definition,author,reason,created_at,promoted_at,retired_at,space_id,?
           FROM ${table} WHERE record_id=?`,
        )
        .run(supersededId, '2026-10-25T00:00:00.000Z', String(source.record_id))
      expect(
        database
          .query(
            `SELECT record_id,superseded_at FROM ${table} WHERE ${foreign}=? AND n=? ORDER BY superseded_at IS NULL DESC`,
          )
          .all(String(source[foreign]), Number(source.n)),
      ).toEqual([
        { record_id: source.record_id, superseded_at: null },
        { record_id: supersededId, superseded_at: '2026-10-25T00:00:00.000Z' },
      ])
    }
  } finally {
    database.close()
  }
})
