// concern: run-retry-claim
/** Revalidates a retry-root tree while its project lease and creation lock are held. */

import { branchOf, gitContext } from '../git/git-environment.ts'
import { worktreeExists } from '../worktree/worktree.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { assertBranchHasNoAliveOwner } from './branch-owner-guard.ts'
import { atomicRetryReuseDecision } from './run-retry.ts'

export function assertRetryRootWorkspace(input: {
  worktree: Worktree
  expectedBranch: string
  validatedTip: string
  conversationRootId: number
  projectId: number | null
  projectName: string | null
  operation: 'creation' | 'reuse'
}): void {
  assertBranchHasNoAliveOwner({
    branch: input.worktree.branch,
    conversationRootId: input.conversationRootId,
    projectId: input.projectId,
    projectName: input.projectName,
  })
  const exists = worktreeExists(input.worktree.path)
  const decision = atomicRetryReuseDecision({
    pathExists: exists,
    actualBranch: exists ? branchOf(input.worktree.path) : null,
    expectedBranch: input.expectedBranch,
    actualHead: exists
      ? gitContext(input.worktree.path, 'rev-parse', '--verify', 'HEAD^{commit}')
      : null,
    validatedTip: input.validatedTip,
  })
  if (decision.action === 'refuse') {
    throw new Error(`refusing retry workspace ${input.operation}: ${decision.reason}`)
  }
}
