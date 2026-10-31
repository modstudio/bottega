import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import type { RequiredReleaseReport } from '../release/release-required.ts'

export const requiredRelease = (
  overrides: Partial<RequiredReleaseReport> = {},
): RequiredReleaseReport => ({
  required: ['hosted-api'],
  releases: [
    {
      rung: 'hosted-api',
      deployExit: 0,
      outputTail: 'pending 0',
      satisfied: true,
      deployed: true,
    },
  ],
  satisfied: true,
  ...overrides,
})

export function recordPassingMergeGate(headCommit: string, cwd: string): void {
  db()
    .query(
      `INSERT INTO gate_execution
        (record_id, requested_at,finished_at,exit_code,timed_out,elapsed_ms,output_tail,head_commit,cwd)
       VALUES ('${newRecordId()}', '2026-10-09','2026-10-09',0,0,100,'passed',?,?)`,
    )
    .run(headCommit, cwd)
}
