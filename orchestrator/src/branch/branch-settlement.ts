// concern: branches
/** Settles run records and claims after a run-minted branch has been deleted. */

import { db, writableDb, writeTransaction } from '../database/db.ts'
import { chainScoreJoin, EVIDENCE_CLOSED_SQL } from '../evidence/evidence-query.ts'
import { settleClaims } from '../resources/resource-claims.ts'

export type ReclaimRun = {
  id: number
  root_id: number
  repo: string | null
  worktree: string
  branch: string | null
  branch_kept: string | null
  branch_kept_tip: string | null
  minted_branch: string | null
  base_commit: string | null
  worktree_source: 'git' | 'recipe' | 'clone' | 'readonly_recipe' | null
  status: string
  pid: number | null
  agent_pid: number | null
  session_id: string | null
  session_last_seen: string | null
  scored: number
  keep_tree: number
  keep_tree_until: string | null
  started_at: string
}

export function branchRows(project: string, branch: string): ReclaimRun[] {
  return db()
    .query(
      `SELECT r.id, COALESCE(r.parent_run_id, r.id) root_id, r.repo,
            COALESCE(r.worktree, '') worktree, r.branch, r.branch_kept,
            r.branch_kept_tip, r.minted_branch,
            r.base_commit, r.worktree_source, r.status, r.pid, r.agent_pid,
            r.session_id, seen.last_seen session_last_seen,
            ${EVIDENCE_CLOSED_SQL} AS scored, r.keep_tree, r.keep_tree_until, r.started_at
       FROM run r ${chainScoreJoin('r', 's')}
       LEFT JOIN session_seen seen ON seen.session_id=r.session_id
      WHERE r.repo=? AND r.minted_branch=? ORDER BY r.id`,
    )
    .all(project, branch) as ReclaimRun[]
}

export function settleDeletedBranch(project: string, branch: string): void {
  writableDb()
  const rows = branchRows(project, branch)
  writeTransaction(() => {
    db()
      .query('UPDATE run SET branch_kept=NULL, branch_kept_tip=NULL WHERE repo=? AND branch_kept=?')
      .run(project, branch)
    for (const row of rows) {
      settleClaims(db(), {
        rootRunId: row.root_id,
        kind: 'branch',
        state: 'released',
        settledAt: new Date().toISOString(),
        detail: `deleted refs/heads/${branch}`,
        allocationKey: `refs/heads/${branch}`,
      })
    }
  })
}
