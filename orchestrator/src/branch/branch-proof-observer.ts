// concern: branches
/** Gathers git and forge facts used by the pure run-branch landing decision. */

import { targetGitEnvironment } from '../git/git-environment.ts'
import type { Project } from '../project/projects.ts'
import { matchAutomaticBranchLandingForTip } from './branch-landing-match.ts'
import type { PatchEquivalentForm } from './branch-state.ts'
import { pullRequestCarriesKey } from './branch-state.ts'
import {
  type MergedPullRequest,
  type PullRequestCommitCheck,
  pullRequestCommitCheck,
} from './merged-pull-request.ts'
import { taskBranchPatchEquivalent } from './task-branch.ts'

function runGit(cwd: string, args: string[]): { exitCode: number; output: string; error: string } {
  const process = Bun.spawnSync(['git', ...args], {
    cwd,
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: process.exitCode,
    output: process.stdout.toString().trim(),
    error: process.stderr.toString().trim(),
  }
}

function git(cwd: string, args: string[]): string {
  const result = runGit(cwd, args)
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error || `exit ${result.exitCode}`}`)
  }
  return result.output
}

export type ObservedBranchLandingProof = {
  branch: string
  tip: string
  commitsNotOnTrunk: number
  matchingPr: boolean
  patchEquivalent: PatchEquivalentForm | null
  pullRequestCommitCheck: PullRequestCommitCheck
}

export function observeBranchLandingProof(input: {
  project: Project
  branch: string
  tip: string
  trunkTip: string
  key: string
  pullRequests: readonly MergedPullRequest[]
  fetchedPullRequests: Map<number, string | null>
}): ObservedBranchLandingProof {
  const commitCount = Number(
    git(input.project.path, ['rev-list', '--count', input.tip, '--not', input.trunkTip]),
  )
  if (!Number.isSafeInteger(commitCount) || commitCount < 0) {
    throw new Error(`git rev-list returned an invalid commit count for ${input.branch}`)
  }
  const matchingPr = matchAutomaticBranchLandingForTip(input.branch, input.tip, input.pullRequests)
  let patchEquivalent: PatchEquivalentForm | null = null
  if (!matchingPr && commitCount > 0) {
    patchEquivalent = taskBranchPatchEquivalent({
      cwd: input.project.path,
      trunkTip: input.trunkTip,
      branchTip: input.tip,
      mergeBase: git(input.project.path, ['merge-base', input.trunkTip, input.tip]),
      commitMessage: `orchestrator branch report ${input.branch}`,
    })
  }
  return {
    branch: input.branch,
    tip: input.tip,
    commitsNotOnTrunk: commitCount,
    matchingPr: matchingPr !== null,
    patchEquivalent,
    pullRequestCommitCheck:
      !matchingPr && commitCount > 0 && !patchEquivalent && input.key !== 'unkeyed'
        ? pullRequestCommitCheck(
            input.project,
            input.pullRequests.filter((pullRequest) =>
              pullRequestCarriesKey(pullRequest, input.key),
            ),
            input.tip,
            input.fetchedPullRequests,
          )
        : null,
  }
}
