// concern: absent-tree close-out
/** Resolves whether a missing worktree has recorded resource teardown to run. */
import { repoRootOf } from '../git/git-environment.ts'
import { projectByName } from '../project/projects.ts'
import { worktreeExists } from '../worktree/worktree.ts'
import { branchTip, hasAbsentTreeTeardownPlan } from '../worktree/worktree-remove.ts'

type AbsentResult = {
  runId: number
  worktree: string
  outcome: 'absent'
  detail: string
}

export function absentTreeCloseOut(input: {
  runId: number
  treePath: string
  repo: string | null
  cwd: string | null
  retainedBranch: string | null
  dryRun?: boolean
  recordRetainedBranch: (tip: string | null) => void
}): { absent: boolean; repoRoot: string | null; result: AbsentResult | null } {
  const absent = !worktreeExists(input.treePath)
  const repoRoot =
    (input.repo ? projectByName(input.repo)?.path : null) ?? repoRootOf(input.treePath) ?? input.cwd
  if (!absent) return { absent, repoRoot, result: null }
  if (!input.dryRun && repoRoot && input.retainedBranch) {
    input.recordRetainedBranch(branchTip(repoRoot, input.retainedBranch))
  }
  if (repoRoot && hasAbsentTreeTeardownPlan(repoRoot, input.runId)) {
    return { absent, repoRoot, result: null }
  }
  return {
    absent,
    repoRoot,
    result: {
      runId: input.runId,
      worktree: input.treePath,
      outcome: 'absent',
      detail: 'worktree was already absent; recorded identity retained',
    },
  }
}
