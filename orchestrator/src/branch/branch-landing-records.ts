// concern: branch landing records
/** The single typed reader for persisted branch landing evidence. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import type { BranchLandingRecord } from './branch-state.ts'

export function readBranchLandingRecords(database: Database = db()): BranchLandingRecord[] {
  return database
    .query(
      `SELECT project,branch,tip,pr_number number,merge_commit mergeCommit,merged_at mergedAt
         FROM branch_landing_record
        ORDER BY project,branch`,
    )
    .all() as BranchLandingRecord[]
}

export type BranchLandingTaskRow = {
  project: string
  branch: string
  recordingSession: string | null
  runRecordId: string | null
  mintedTaskKey: string | null
  branchTaskKey: string | null
}

/** Read landing evidence together with both run relations that can identify its task. */
export function readBranchLandingTaskRows(database: Database = db()): BranchLandingTaskRow[] {
  return database
    .query<BranchLandingTaskRow, []>(
      // Materialize because run has no index on (project_record_id, minted_branch) or branch.
      `WITH runs AS MATERIALIZED (
         SELECT record_id,project_record_id,minted_branch,branch,launch_key
           FROM run
          WHERE minted_branch IS NOT NULL OR branch IS NOT NULL
       )
       SELECT DISTINCT blr.project,blr.branch,blr.recording_session recordingSession,
              owner.record_id runRecordId,minted.launch_key mintedTaskKey,
              branch_run.launch_key branchTaskKey
         FROM branch_landing_record blr
         LEFT JOIN runs owner
           ON owner.project_record_id=blr.project_record_id AND owner.minted_branch=blr.branch
         LEFT JOIN runs minted
           ON minted.project_record_id=blr.project_record_id AND minted.minted_branch=blr.branch
          AND minted.launch_key IS NOT NULL
         LEFT JOIN runs branch_run
           ON branch_run.project_record_id=blr.project_record_id AND branch_run.branch=blr.branch
          AND branch_run.launch_key IS NOT NULL
        ORDER BY blr.project,blr.branch,owner.record_id,minted.launch_key,branch_run.launch_key`,
    )
    .all()
}

/** Resolve a landing key from its run relations, then from a registered branch-name prefix. */
export function resolveBranchLandingTaskKey(
  row: Pick<BranchLandingTaskRow, 'branch' | 'mintedTaskKey' | 'branchTaskKey'>,
  keyPrefixes: readonly string[],
): string | null {
  if (row.mintedTaskKey?.trim()) return row.mintedTaskKey.trim().toUpperCase()
  if (row.branchTaskKey?.trim()) return row.branchTaskKey.trim().toUpperCase()
  const registered = new Set(keyPrefixes.map((prefix) => prefix.toUpperCase()))
  const token = /(?:^|[^a-z0-9])([a-z][a-z0-9]*)-(\d+)(?=$|[^0-9])/gi.exec(row.branch)
  if (!token) return null
  const prefix = token[1]!.toUpperCase()
  return registered.has(prefix) ? `${prefix}-${token[2]}` : null
}
