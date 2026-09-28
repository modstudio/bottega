// concern: branches
/** Looks up a pull-request number for a task key's branch. Must not know workflow floors. */
import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'

/** The branch recorded for this task key, or the cursor branch when supplied. */
export function branchForTaskKey(
  project: string,
  taskKey: string,
  cursorBranch: string | null,
  d: Database = db(),
): string | null {
  if (cursorBranch?.trim()) return cursorBranch.trim()
  const key = taskKey.trim()
  if (!key) return null
  const like = `${key}-%`
  const landing = d
    .query<{ branch: string }, [string, string, string, string]>(
      `SELECT blr.branch AS branch
         FROM branch_landing_record blr
        WHERE blr.project=?
          AND (
            blr.branch=?
            OR blr.branch LIKE ?
            OR EXISTS (
              SELECT 1 FROM run r
              WHERE r.launch_key=?
                AND (r.branch=blr.branch OR r.minted_branch=blr.branch)
            )
          )
        ORDER BY blr.merged_at DESC, blr.pr_number DESC
        LIMIT 1`,
    )
    .get(project, key, like, key)
  if (landing) return landing.branch
  const snapshot = d
    .query<{ branch: string }, [string, string, string]>(
      `SELECT branch
         FROM landing_triage_snapshot
        WHERE project=?
          AND (branch=? OR branch LIKE ?)
          AND pr_number IS NOT NULL
        ORDER BY at DESC, id DESC
        LIMIT 1`,
    )
    .get(project, key, like)
  return snapshot?.branch ?? null
}

/** PR number from a landing record, else from the triage snapshot for this branch. */
export function pullRequestNumberForBranch(
  project: string,
  branch: string,
  d: Database = db(),
): number | null {
  const landing = d
    .query<{ pr_number: number }, [string, string]>(
      `SELECT pr_number
         FROM branch_landing_record
        WHERE project=? AND branch=?
        ORDER BY merged_at DESC, pr_number DESC
        LIMIT 1`,
    )
    .get(project, branch)
  if (landing) return landing.pr_number
  const snapshot = d
    .query<{ pr_number: number }, [string, string]>(
      `SELECT pr_number
         FROM landing_triage_snapshot
        WHERE project=? AND branch=? AND pr_number IS NOT NULL
        ORDER BY at DESC, id DESC
        LIMIT 1`,
    )
    .get(project, branch)
  return snapshot?.pr_number ?? null
}
