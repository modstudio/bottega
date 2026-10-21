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
