import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from './migrations.ts'
import { fixtureProjectRecordId, migrationBoundaryTestDatabase } from './test-database.fixture.ts'

test('run call usage migration leaves historical runs unknown', () => {
  const database = migrationBoundaryTestDatabase('0171_run_call_usage')
  try {
    const id = newRecordId()
    database
      .query(
        `INSERT INTO run
         (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id)
         VALUES (?,999,'2026-10-26T00:00:00.000Z','codex','understand','sha',1,'head','ok',?)`,
      )
      .run(id, fixtureProjectRecordId(database))
    expect(applyMigrations(database)).toContain('0171_run_call_usage')
    expect(
      database.query('SELECT model_calls,peak_call_tokens FROM run WHERE record_id=?').get(id),
    ).toEqual({ model_calls: null, peak_call_tokens: null })
  } finally {
    database.close()
  }
})
