// concern: offline-branch-landing
/** Observes the local facts consumed by the branch landing classifier without consulting GitHub. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import type { Project } from '../project/projects.ts'
import { projects } from '../project/projects.ts'
import {
  type BranchLandingRecord,
  decideBranchState,
  findRecordedBranchLanding,
  type PatchEquivalentForm,
} from './branch-state.ts'
import { taskBranchPatchEquivalent } from './task-branch.ts'

export type OfflineBranchLandingCandidate = {
  projectId: number
  project: string
  branch: string
}

export type OfflineBranchLandingObservation = OfflineBranchLandingCandidate & {
  branchExists: boolean
  landed: boolean
}

function git(cwd: string, ...args: string[]): string {
  const process = Bun.spawnSync(['git', ...args], {
    cwd,
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (process.exitCode !== 0) {
    throw new Error(process.stderr.toString().trim() || `git ${args.join(' ')} failed`)
  }
  return process.stdout.toString().trim()
}

function localBranches(project: Project): Map<string, string> {
  const output = git(
    project.path,
    'for-each-ref',
    '--format=%(refname:short)%09%(objectname)',
    'refs/heads',
  )
  return new Map(
    output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [branch, tip, ...extra] = line.split('\t')
        if (!branch || !tip || extra.length) {
          throw new Error(`git for-each-ref returned an unexpected row: ${line}`)
        }
        return [branch, tip]
      }),
  )
}

function recordedLandings(database: Database): BranchLandingRecord[] {
  return database
    .query(
      `SELECT project,branch,tip,pr_number number,merge_commit mergeCommit,merged_at mergedAt
         FROM branch_landing_record`,
    )
    .all() as BranchLandingRecord[]
}

function classifyExistingBranch(input: {
  candidate: OfflineBranchLandingCandidate
  project: Project
  tip: string
  trunkTip: string
  records: readonly BranchLandingRecord[]
}): OfflineBranchLandingObservation {
  const { candidate, project, tip, trunkTip } = input
  const recordedLanding = findRecordedBranchLanding(input.records, project.name, candidate.branch)
  const commitsNotOnTrunk = Number(git(project.path, 'rev-list', '--count', tip, '--not', trunkTip))
  if (!Number.isSafeInteger(commitsNotOnTrunk) || commitsNotOnTrunk < 0) {
    throw new Error(`git rev-list returned an invalid commit count for ${candidate.branch}`)
  }
  let patchEquivalent: PatchEquivalentForm | null = null
  if (commitsNotOnTrunk > 0 && recordedLanding?.tip !== tip) {
    patchEquivalent = taskBranchPatchEquivalent({
      cwd: project.path,
      trunkTip,
      branchTip: tip,
      mergeBase: git(project.path, 'merge-base', trunkTip, tip),
      commitMessage: `orch branch report ${candidate.branch}`,
    })
  }
  const state = decideBranchState({
    branch: candidate.branch,
    tip,
    mergedPullRequests: [],
    mergedPullRequestsTruncated: false,
    commitsNotOnTrunk,
    patchEquivalent,
    pullRequestCommitCheck: null,
    recordedLanding,
    laterTurnBranches: [],
    superseded: false,
  })
  return { ...candidate, branchExists: true, landed: state.state === 'landed' }
}

function observeProject(
  project: Project,
  candidates: readonly OfflineBranchLandingCandidate[],
  records: readonly BranchLandingRecord[],
): OfflineBranchLandingObservation[] {
  const trunk = project.settings.trunk?.trim()
  if (!trunk) return []
  const branches = localBranches(project)
  const trunkTip = git(
    project.path,
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${trunk}^{commit}`,
  )
  return candidates.map((candidate) => {
    const tip = branches.get(candidate.branch)
    return tip
      ? classifyExistingBranch({ candidate, project, tip, trunkTip, records })
      : { ...candidate, branchExists: false, landed: false }
  })
}

/** Batch local ref reads by project and omit observations that local Git cannot establish. */
export function offlineBranchLandingObservations(
  candidates: readonly OfflineBranchLandingCandidate[],
  database: Database = db(),
): OfflineBranchLandingObservation[] {
  const registered = [...projects(undefined, database), ...projects({ retired: true }, database)]
  const selected = new Map(registered.map((project) => [project.id, project]))
  const records = recordedLandings(database)
  return [...Map.groupBy(candidates, (candidate) => candidate.projectId)].flatMap(
    ([projectId, projectCandidates]) => {
      const project = selected.get(projectId)
      if (!project) return []
      try {
        return observeProject(project, projectCandidates, records)
      } catch {
        return []
      }
    },
  )
}
