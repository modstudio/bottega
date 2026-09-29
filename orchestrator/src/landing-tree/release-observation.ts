// concern: landing-tree
/** Observes the repository facts used to decide whether sweep may release a landing tree. */

import { taskBranchAlreadyLanded, taskBranchPatchEquivalent } from '../branch/task-branch.ts'
import { git, gitContext } from '../git/git-environment.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import { LANDING_TREE_JOB } from '../run/synthetic-lifecycle-job.ts'
import { type LandingTreeReleaseDecision, landingTreeReleaseDecision } from './landing-tree.ts'

export type LandingTreeReleaseRow = {
  job: string
  repo: string | null
  worktree: string
  branch: string | null
  sessionId: string | null
  launchKey: string | null
  status: string
  treeExists: boolean
  landingInFlight: boolean
}

function unavailable(row: LandingTreeReleaseRow, detail: string): LandingTreeReleaseDecision {
  const owner = row.sessionId ? `session ${row.sessionId}` : 'its invoking session'
  return {
    action: 'keep',
    reason: `landing tree held by ${owner}: landing status could not be established (${detail})`,
  }
}

export function observeLandingTreeRelease(row: LandingTreeReleaseRow): LandingTreeReleaseDecision {
  if (row.job !== LANDING_TREE_JOB) return { action: 'release' }
  try {
    const project = row.repo ? projectByName(row.repo) : projectAt(row.worktree)
    if (!project || !row.branch) return unavailable(row, 'project or branch is no longer recorded')
    const decisionFacts = {
      job: row.job,
      sessionId: row.sessionId,
      treeExists: row.treeExists,
      status: row.status,
      landingInFlight: row.landingInFlight,
    }
    if (!row.treeExists) return landingTreeReleaseDecision(decisionFacts, false, false)
    const trunk = project.settings.trunk?.trim()
    if (!trunk) return unavailable(row, `project ${project.name} has no registered trunk`)
    const cleanStatus = git(['status', '--porcelain=v1', '--untracked-files=all'], row.worktree)
    if (cleanStatus !== '') {
      return landingTreeReleaseDecision(decisionFacts, false, false)
    }
    const branchTip = gitContext(
      project.path,
      'rev-parse',
      '--verify',
      `refs/heads/${row.branch}^{commit}`,
    )
    if (!branchTip) return unavailable(row, `refs/heads/${row.branch} is missing`)
    const trunkTip = gitContext(project.path, 'rev-parse', '--verify', `${trunk}^{commit}`)
    if (!trunkTip) return unavailable(row, `trunk ${trunk} is missing`)
    const mergeBase = gitContext(project.path, 'merge-base', trunkTip, branchTip)
    if (!mergeBase) return unavailable(row, 'merge base is unavailable')
    const landed = row.launchKey
      ? taskBranchAlreadyLanded({
          project,
          repoRoot: project.path,
          launchKey: row.launchKey,
          branch: row.branch,
          tip: branchTip,
          trunk,
          trunkTip,
          mergeBase,
        })
      : Boolean(
          taskBranchPatchEquivalent({
            cwd: project.path,
            trunkTip,
            branchTip,
            mergeBase,
            commitMessage: `orch landing tree ${row.branch}`,
          }),
        )
    return landingTreeReleaseDecision(decisionFacts, true, landed)
  } catch (error) {
    return unavailable(row, String((error as Error)?.message ?? error))
  }
}
