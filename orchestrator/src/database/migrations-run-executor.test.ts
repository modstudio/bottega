import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from './migrations.ts'
import { fixtureProjectRecordId, migrationBoundaryTestDatabase } from './test-database.fixture.ts'

test('run executor migration defaults existing rows to external and constrains new values', () => {
  const database = migrationBoundaryTestDatabase('0169_run_executor')
  try {
    const id = newRecordId()
    database
      .query(
        `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id)
       VALUES (?,999,'2026-10-25T00:00:00.000Z','codex','understand','sha',1,'head','ok',?)`,
      )
      .run(id, fixtureProjectRecordId(database))
    expect(applyMigrations(database)).toContain('0169_run_executor')
    expect(
      database.query('SELECT executor,harness_wall_bound_ms FROM run WHERE record_id=?').get(id),
    ).toEqual({
      executor: 'external',
      harness_wall_bound_ms: null,
    })
    expect(() => database.query("UPDATE run SET executor='other'").run()).toThrow()
  } finally {
    database.close()
  }
})
