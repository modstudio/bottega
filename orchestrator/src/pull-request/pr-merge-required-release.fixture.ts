import { newRecordId } from '../../../shared/record-id.ts'
import { fileURLToPath } from 'node:url'
import { db } from '../database/db.ts'
import type { RequiredReleaseReport } from '../release/release-required.ts'
import type { ShipCleanupReport } from '../ship-cleanup/ship-cleanup.ts'
import { decideShipCleanupVerdict } from '../ship-cleanup/ship-cleanup-decision.ts'

const cwd = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')

export const cleanupReport = (
  overrides: Partial<Pick<ShipCleanupReport, 'kept' | 'errors'>> = {},
): ShipCleanupReport => ({
  project: 'merge-fixture',
  branch: 'DEV-1255-admission',
  landingBranch: 'main',
  mainCheckoutPath: cwd,
  freed: { artifacts: 0, scratch: 0, worktrees: 0 },
  removed: { artifacts: [], scratch: [], worktrees: [], branches: [] },
  absentWorktrees: [],
  reclaimed: { processes: [], compose: [] },
  gone: [],
  kept: overrides.kept ?? [],
  errors: overrides.errors ?? [],
  verdict: decideShipCleanupVerdict({
    kept: overrides.kept ?? [],
    errors: overrides.errors ?? [],
  }),
})

export const requiredRelease = (
  overrides: Partial<RequiredReleaseReport> = {},
): RequiredReleaseReport => ({
  required: ['hosted-api'],
  releases: [
    {
      rung: 'hosted-api',
      required: true,
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
