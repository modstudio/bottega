// concern: workflow checkout landing
/** Resolves the commit that landed a workflow cursor's branch. */

import type { Database } from 'bun:sqlite'
import { viewPullRequest } from '../branch/merged-pull-request.ts'
import { latestBranchLanding, pullRequestNumberForBranch } from '../branch/task-key-pull-request.ts'
import { projectByName } from '../project/projects.ts'

/** Reads a recorded landing first, then the merged pull request named by admission evidence. */
export function checkoutLandingCommit(
  project: string,
  branch: string | null,
  d: Database,
): string | null {
  if (!branch) return null
  const recorded = latestBranchLanding(project, branch, d)
  if (recorded?.mergeCommit) return recorded.mergeCommit
  const number = recorded?.pullRequestNumber ?? pullRequestNumberForBranch(project, branch, d)
  const registered = projectByName(project, d)
  if (number === null || !registered) return null
  const pullRequest = viewPullRequest(registered, number)
  return pullRequest.state === 'MERGED' ? (pullRequest.mergeCommit ?? null) : null
}
