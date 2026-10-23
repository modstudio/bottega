// concern: workflow checkout landing
/** Resolves the commit that landed a workflow cursor's branch. */

import type { Database } from 'bun:sqlite'
import { viewPullRequest } from '../branch/merged-pull-request.ts'
import { latestBranchLanding, pullRequestNumberForBranch } from '../branch/task-key-pull-request.ts'
import { projectByName } from '../project/projects.ts'

export type CheckoutLanding = {
  commit: string | null
  recordedTip: string | null
}

/** Reads the commit and recorded branch tip for the latest landing. */
export function checkoutLanding(
  project: string,
  branch: string | null,
  d: Database,
): CheckoutLanding {
  if (!branch) return { commit: null, recordedTip: null }
  const recorded = latestBranchLanding(project, branch, d)
  if (recorded?.mergeCommit) return { commit: recorded.mergeCommit, recordedTip: recorded.tip }
  const number = recorded?.pullRequestNumber ?? pullRequestNumberForBranch(project, branch, d)
  const registered = projectByName(project, d)
  if (number === null || !registered) return { commit: null, recordedTip: recorded?.tip ?? null }
  const pullRequest = viewPullRequest(registered, number)
  return {
    commit: pullRequest.state === 'MERGED' ? (pullRequest.mergeCommit ?? null) : null,
    recordedTip: recorded?.tip ?? null,
  }
}
