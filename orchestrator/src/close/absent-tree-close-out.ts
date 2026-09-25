// concern: absent-tree close-out
/** Resolves whether a missing worktree has recorded resource teardown to run. */
import { repoRootOf } from '../git/git-environment.ts'
import { projectByName } from '../project/projects.ts'
import { proveWorktreeReconstructible } from '../reclaim/reclaim.ts'
import { worktreeExists } from '../worktree/worktree.ts'
import { branchTip, hasAbsentTreeTeardownPlan } from '../worktree/worktree-remove.ts'

type AbsentResult = {
  runId: number
  worktree: string
  outcome: 'absent'
  detail: string
}

type ReleasedResult = Omit<AbsentResult, 'outcome'> & { outcome: 'released' }
type HeldResult = Omit<AbsentResult, 'outcome'> & { outcome: 'held' }

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

export function dryRunReleaseResult(
  runId: number,
  treePath: string,
  treeAbsent: boolean,
): AbsentResult | ReleasedResult {
  if (treeAbsent)
    return {
      runId,
      worktree: treePath,
      outcome: 'absent',
      detail:
        'worktree was already absent; would run its recorded resource teardown and keep its branch',
    }
  return {
    runId,
    worktree: treePath,
    outcome: 'released',
    detail: 'would release clean terminal worktree and keep its branch',
  }
}

export function reconstructibilityHold(
  runId: number,
  treePath: string,
  treeAbsent: boolean,
): HeldResult | null {
  if (treeAbsent) return null
  const proof = proveWorktreeReconstructible(treePath)
  return proof.ok ? null : { runId, worktree: treePath, outcome: 'held', detail: proof.action }
}

export function successfulReleaseResult(
  runId: number,
  treePath: string,
  treeAbsent: boolean,
  result: { detail: string; output?: string; resourceTeardownCompleted?: true },
): (AbsentResult | ReleasedResult) & { resourceTeardownCompleted?: true } {
  if (!treeAbsent)
    return {
      runId,
      worktree: treePath,
      outcome: 'released',
      detail: result.output ? `${result.detail}\n${result.output}` : result.detail,
      ...(result.resourceTeardownCompleted ? { resourceTeardownCompleted: true as const } : {}),
    }
  return {
    runId,
    worktree: treePath,
    outcome: 'absent',
    detail: result.output
      ? `worktree was already absent; resources torn down\n${result.output}`
      : 'worktree was already absent; resources torn down',
    ...(result.resourceTeardownCompleted ? { resourceTeardownCompleted: true as const } : {}),
  }
}
