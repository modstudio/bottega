// concern: task-branch
/**
 * Knows the project register, branch content status, and database reads. Must
 * not know transports, contracts, or routing.
 */

import { type PatchEquivalentForm, pullRequestCarriesKey } from './branch-state.ts'
import { realpathOrSpelled } from './checkout-identity.ts'
import { db } from './db.ts'
import { repoRootOf, targetGitEnvironment } from './git-environment.ts'
import {
  GH_MERGED_PR_LIMIT,
  mergedPullRequests,
  pullRequestCommitCheck,
  pullRequestNameCheck,
} from './merged-pull-request.ts'
import type { Project } from './projects.ts'
import { projectAt, projects } from './projects.ts'
import { reviewRunEvidenceSql } from './review-evidence-sql.ts'
import type { Worktree } from './worktree-types.ts'

export type TaskBranchCandidate = {
  branch: string
  tip: string
  commitCount: number
  mergeBase: string
  projectId: number
  projectName: string
  runIds: number[]
  worktree: Worktree | null
}

export type TaskBranchRunRow = {
  id: number
  parent_run_id: number | null
  branch: string
  launch_base: string | null
}

export type TaskBranchPullRequestCheck =
  | { state: 'landed'; landedBy: 'name' | 'pr-commits'; number: number }
  | { state: 'unmatched' }
  | { state: 'unknown'; reason: string }

export type TaskBranchLandingDecision =
  | { action: 'skip'; number?: number }
  | { action: 'keep' }
  | { action: 'refuse'; message: string }

/** Decide whether dispatch may reuse one observed task branch. */
export function decideTaskBranchLanding(input: {
  branch: string
  tip: string
  trunk: string
  localCheck: PatchEquivalentForm | null
  pullRequestCheck: TaskBranchPullRequestCheck
}): TaskBranchLandingDecision {
  if (input.localCheck) return { action: 'skip' }
  if (input.pullRequestCheck.state === 'landed') {
    return { action: 'skip', number: input.pullRequestCheck.number }
  }
  if (input.pullRequestCheck.state === 'unknown') {
    return {
      action: 'refuse',
      message:
        `refusing task branch ${input.branch} tip ${input.tip}: ` +
        `GitHub landing check could not complete: ${input.pullRequestCheck.reason}; ` +
        `rerun with --base ${input.trunk}`,
    }
  }
  return { action: 'keep' }
}

/** Observe whether a merged pull request contains one task branch's content. */
function taskBranchPullRequestCheck(input: {
  project: Project
  launchKey: string
  branch: string
  tip: string
}): TaskBranchPullRequestCheck {
  let listing: ReturnType<typeof mergedPullRequests>
  try {
    listing = mergedPullRequests(input.project)
  } catch (error) {
    return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }
  }
  const pullRequests = listing.pullRequests.sort((left, right) =>
    right.mergedAt.localeCompare(left.mergedAt),
  )
  const fetched = new Map<number, string | null>()
  const nameCheck = pullRequestNameCheck(
    input.project,
    pullRequests,
    input.branch,
    input.tip,
    fetched,
  )
  if (nameCheck && 'error' in nameCheck) return { state: 'unknown', reason: nameCheck.error }
  if (nameCheck && 'pullRequest' in nameCheck && nameCheck.containsTip) {
    return { state: 'landed', landedBy: 'name', number: nameCheck.pullRequest.number }
  }
  const commitCheck = pullRequestCommitCheck(
    input.project,
    pullRequests.filter((pullRequest) => pullRequestCarriesKey(pullRequest, input.launchKey)),
    input.tip,
    fetched,
  )
  if (commitCheck && 'error' in commitCheck) {
    return { state: 'unknown', reason: commitCheck.error }
  }
  if (commitCheck && 'number' in commitCheck) {
    return { state: 'landed', landedBy: 'pr-commits', number: commitCheck.number }
  }
  if (listing.truncated) {
    return {
      state: 'unknown',
      reason: `merged pull-request listing reached ${GH_MERGED_PR_LIMIT} entries and may be truncated`,
    }
  }
  return { state: 'unmatched' }
}

function taskBranchAlreadyLanded(input: {
  project: Project
  repoRoot: string
  launchKey: string
  branch: string
  tip: string
  trunk: string
  trunkTip: string
  mergeBase: string
}): boolean {
  const localCheck = taskBranchPatchEquivalent({
    cwd: input.repoRoot,
    trunkTip: input.trunkTip,
    branchTip: input.tip,
    mergeBase: input.mergeBase,
    commitMessage: `orch task branch ${input.launchKey}`,
  })
  if (localCheck) return true
  const landing = decideTaskBranchLanding({
    branch: input.branch,
    tip: input.tip,
    trunk: input.trunk,
    localCheck,
    pullRequestCheck: taskBranchPullRequestCheck(input),
  })
  if (landing.action === 'refuse') throw new Error(landing.message)
  return landing.action === 'skip'
}

/** Whether a later explicit-base root moved the task's ownership to another branch. */
export function isTaskBranchSuperseded(branch: string, rows: readonly TaskBranchRunRow[]): boolean {
  const branchRunIds = rows.filter((row) => row.branch === branch).map((row) => row.id)
  if (branchRunIds.length === 0) return false
  const latestBranchRunId = Math.max(...branchRunIds)
  return rows.some(
    (row) =>
      row.id > latestBranchRunId &&
      row.parent_run_id === null &&
      row.launch_base !== null &&
      row.branch !== branch,
  )
}

function taskBranchCandidacySql(runAlias = 'candidate'): string {
  return `${runAlias}.status <> 'stopped'`
}

function taskBranchGit(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], {
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed while resolving the task branch: ` +
        (p.stderr.toString().trim() || `exit ${p.exitCode}`),
    )
  }
  return p.stdout.toString().trim()
}

/** Which existing task-branch landing shape, if any, is already present on trunk. */
export function taskBranchPatchEquivalent(input: {
  cwd: string
  trunkTip: string
  branchTip: string
  mergeBase: string
  commitMessage: string
}): PatchEquivalentForm | null {
  const individual = taskBranchGit(input.cwd, 'cherry', input.trunkTip, input.branchTip)
  if (!individual.split('\n').some((line) => line.startsWith('+ '))) return 'commits'
  const tree = taskBranchGit(input.cwd, 'rev-parse', '--verify', `${input.branchTip}^{tree}`)
  const squash = taskBranchGit(
    input.cwd,
    'commit-tree',
    tree,
    '-p',
    input.mergeBase,
    '-m',
    input.commitMessage,
  )
  const cherry = taskBranchGit(input.cwd, 'cherry', input.trunkTip, squash)
  return cherry.split('\n').some((line) => line.startsWith('+ ')) ? null : 'squash'
}

function checkedOutWorktree(repoRoot: string, branch: string): string | null {
  let path: string | null = null
  for (const line of taskBranchGit(repoRoot, 'worktree', 'list', '--porcelain').split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line === `branch refs/heads/${branch}`) return path
    else if (!line) path = null
  }
  return null
}

export function resolveTaskBranch(cwd: string, launchKey: string): TaskBranchCandidate | null {
  const repoRoot = repoRootOf(cwd)
  const project =
    projectAt(cwd) ??
    (repoRoot
      ? (projects().find(
          (candidate) => realpathOrSpelled(candidate.path) === realpathOrSpelled(repoRoot),
        ) ?? null)
      : null)
  if (!project || !repoRoot) return null
  const rows = db()
    .query(
      `WITH candidate AS (SELECT run.*, run.id AS run_id FROM run)
     SELECT candidate.id, candidate.parent_run_id, candidate.branch,
            candidate.launch_base, candidate.worktree, candidate.worktree_source
       FROM candidate
      WHERE candidate.launch_key=?
        AND (candidate.project_id=? OR (candidate.project_id IS NULL AND candidate.repo=?))
        AND candidate.branch IS NOT NULL
        AND ${taskBranchCandidacySql('candidate')}
        AND ${reviewRunEvidenceSql('candidate', 'candidate')}
      ORDER BY candidate.id`,
    )
    .all(launchKey, project.id, project.name) as (TaskBranchRunRow & {
    worktree: string | null
    worktree_source: string | null
  })[]
  if (rows.length === 0) return null

  const trunk = project.settings.trunk?.trim()
  if (!trunk) {
    throw new Error(
      `project ${project.name} has no trunk configured; task branch content cannot be resolved`,
    )
  }

  const byBranch = new Map<string, typeof rows>()
  for (const row of rows) byBranch.set(row.branch, [...(byBranch.get(row.branch) ?? []), row])
  const trunkTip = taskBranchGit(
    repoRoot,
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${trunk}^{commit}`,
  )
  const candidates: TaskBranchCandidate[] = []
  const liveBranches = [...byBranch].filter(([branch]) => !isTaskBranchSuperseded(branch, rows))
  for (const [branch, branchRows] of liveBranches) {
    let tip: string
    try {
      tip = taskBranchGit(
        repoRoot,
        'rev-parse',
        '--verify',
        '--end-of-options',
        `refs/heads/${branch}^{commit}`,
      )
    } catch {
      continue
    }
    const mergeBase = taskBranchGit(repoRoot, 'merge-base', trunkTip, tip)
    const commitCount = Number(
      taskBranchGit(repoRoot, 'rev-list', '--count', `${mergeBase}..${tip}`),
    )
    if (!Number.isSafeInteger(commitCount) || commitCount < 1) continue

    if (
      taskBranchAlreadyLanded({
        project,
        repoRoot,
        launchKey,
        branch,
        tip,
        trunk,
        trunkTip,
        mergeBase,
      })
    )
      continue

    const path = checkedOutWorktree(repoRoot, branch)
    const attachedRow = path
      ? branchRows.find(
          (row) => row.worktree && realpathOrSpelled(row.worktree) === realpathOrSpelled(path),
        )
      : null
    const source = attachedRow?.worktree_source
    candidates.push({
      branch,
      tip,
      commitCount,
      mergeBase,
      projectId: project.id,
      projectName: project.name,
      runIds: branchRows.map((row) => row.id),
      worktree: path
        ? {
            path,
            branch,
            base: tip,
            repoRoot,
            source:
              source === 'recipe' || source === 'git' || source === 'readonly_recipe'
                ? source
                : undefined,
            // Null records that this run attached; it did not mint the task branch.
            mintedBranch: null,
          }
        : null,
    })
  }

  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]!
  const detail = candidates
    .map(
      (candidate) => `  ${candidate.branch} tip ${candidate.tip} commits ${candidate.commitCount}`,
    )
    .join('\n')
  const commands = candidates
    .map((kept) => {
      const voidCommands = candidates
        .filter((candidate) => candidate !== kept)
        .flatMap((candidate) => candidate.runIds)
        .map((id) => `    orch score ${id} --void --note "not the live ${launchKey} branch"`)
        .join('\n')
      return `  To keep ${kept.branch}:\n${voidCommands}`
    })
    .join('\n')
  throw new Error(
    `refusing task branch resolution for ${launchKey}: more than one branch carries content not on ${trunk}\n` +
      `${detail}\n` +
      `invariant: A task owns one branch.\n` +
      `Clear the ambiguity by choosing one branch and voiding the candidate runs behind the others:\n${commands}`,
  )
}
