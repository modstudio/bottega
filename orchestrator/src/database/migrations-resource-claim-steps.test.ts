import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

test('resource claim step migration preserves existing claim identity', () => {
  const database = migrationBoundaryTestDatabase('0212_resource_claim_steps')
  try {
    const runId = newRecordId()
    const claimId = newRecordId()
    database
      .query(
        `INSERT INTO run
         (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
         VALUES (?,991,'2026-11-07','codex','understand','sha',1,'prompt','running')`,
      )
      .run(runId)
    database
      .query(
        `INSERT INTO resource_claim
         (record_id,number,root_run_record_id,run_record_id,kind,allocation_key,state,claimed_at)
         VALUES (?,991,?,?,'worktree','/tmp/preserved','claimed','2026-11-07')`,
      )
      .run(claimId, runId, runId)

    expect(applyMigrations(database)).toEqual(['0212_resource_claim_steps'])
    expect(
      database
        .query(
          `SELECT record_id,kind,allocation_key,state,step_no,lifetime,shared
           FROM resource_claim WHERE record_id=?`,
        )
        .get(claimId),
    ).toEqual({
      record_id: claimId,
      kind: 'worktree',
      allocation_key: '/tmp/preserved',
      state: 'claimed',
      step_no: null,
      lifetime: 'runtime',
      shared: 0,
    })
  } finally {
    database.close()
  }
})
