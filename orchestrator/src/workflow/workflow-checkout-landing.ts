// concern: workflow checkout landing
/** Resolves the commit that landed a workflow cursor's branch. */

import type { Database } from 'bun:sqlite'
import { viewPullRequest } from '../branch/merged-pull-request.ts'
import { pullRequestNumberForBranch } from '../branch/task-key-pull-request.ts'
import { projectByName } from '../project/projects.ts'

function recordedLandingCommit(project: string, branch: string, d: Database): string | null {
  return (
    d
      .query<{ merge_commit: string | null }, [string, string]>(
        `SELECT merge_commit FROM branch_landing_record
          WHERE project_record_id=(SELECT record_id FROM project WHERE name=?) AND branch=?
          ORDER BY merged_at DESC, pr_number DESC LIMIT 1`,
      )
      .get(project, branch)?.merge_commit ?? null
  )
}

/** Reads a recorded landing first, then the merged pull request named by admission evidence. */
export function checkoutLandingCommit(
  project: string,
  branch: string | null,
  d: Database,
): string | null {
  if (!branch) return null
  const recorded = recordedLandingCommit(project, branch, d)
  if (recorded) return recorded
  const number = pullRequestNumberForBranch(project, branch, d)
  const registered = projectByName(project, d)
  if (number === null || !registered) return null
  const pullRequest = viewPullRequest(registered, number)
  return pullRequest.state === 'MERGED' ? (pullRequest.mergeCommit ?? null) : null
}
