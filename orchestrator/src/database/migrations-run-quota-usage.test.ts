import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from './migrations.ts'
import { fixtureProjectRecordId, migrationBoundaryTestDatabase } from './test-database.fixture.ts'

test('run quota usage migration leaves historical readings unknown', () => {
  const database = migrationBoundaryTestDatabase('0174_run_quota_usage')
  try {
    const id = newRecordId()
    database
      .query(
        `INSERT INTO run
         (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id)
         VALUES (?,999,'2026-10-28T00:00:00.000Z','codex','understand','sha',1,'head','ok',?)`,
      )
      .run(id, fixtureProjectRecordId(database))
    expect(applyMigrations(database)).toContain('0174_run_quota_usage')
    expect(
      database
        .query(
          `SELECT quota_used_percent_start,quota_used_percent_end,
                  quota_window_minutes,quota_resets_at FROM run WHERE record_id=?`,
        )
        .get(id),
    ).toEqual({
      quota_used_percent_start: null,
      quota_used_percent_end: null,
      quota_window_minutes: null,
      quota_resets_at: null,
    })
  } finally {
    database.close()
  }
})
