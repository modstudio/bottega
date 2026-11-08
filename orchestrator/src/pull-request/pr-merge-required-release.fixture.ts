import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import type { RequiredReleaseReport } from '../release/release-required.ts'
import type { ShipCleanupReport } from '../ship-cleanup/ship-cleanup.ts'
import { decideShipCleanupVerdict } from '../ship-cleanup/ship-cleanup-decision.ts'

export const mergeCleanupReport = (
  cwd: string,
  branch: string,
  overrides: Partial<Pick<ShipCleanupReport, 'kept' | 'errors'>> = {},
): ShipCleanupReport => ({
  project: 'merge-fixture',
  branch,
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

export function registerMergeProject(
  cwd: string,
  requiredChecks: string[],
  mergeQueue = false,
): void {
  db()
    .query(
      'INSERT INTO project (record_id,name,path,stack,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?,?)',
    )
    .run(
      'merge-fixture',
      cwd,
      'bun',
      JSON.stringify({
        trunk: 'main',
        release: { rungs: [], mergeMethod: 'squash', requiredChecks, mergeQueue },
      }),
    )
}

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
