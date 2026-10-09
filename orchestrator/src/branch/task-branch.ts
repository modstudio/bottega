// concern: task-branch
/**
 * Knows the project register, branch content status, and database reads. Must
 * not know transports, contracts, or routing.
 */

import { db } from '../database/db.ts'
import { realpathOrSpelled } from '../git/checkout-identity.ts'
import { checkedOutWorktree, repoRootOf, targetGitEnvironment } from '../git/git-environment.ts'
import type { Project } from '../project/projects.ts'
import { projectAt, projects } from '../project/projects.ts'
import { reviewRunEvidenceSql } from '../review/review-evidence-sql.ts'
import type { TaskBranchNominatingRun } from '../run/run-types.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { type PatchEquivalentForm, pullRequestCarriesKey } from './branch-state.ts'
import {
  GH_TARGETED_MERGED_PR_LIMIT,
  type GitHubPullRequest,
  type MergedPullRequest,
  type PullRequestCommitCheck,
  type PullRequestListing,
  type PullRequestNameCheck,
  pullRequestCommitCheck,
  pullRequestNameCheck,
  targetedMergedPullRequests,
  targetedTaskBranchPullRequests,
} from './merged-pull-request.ts'

export type TaskBranchCandidate = {
  branch: string
  tip: string
  commitCount: number
  mergeBase: string
  projectId: number
  projectName: string
  nominatingRuns: TaskBranchNominatingRun[]
  trunk: string
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
  | { state: 'closed-unmerged'; number: number }
  | { state: 'unmatched' }
  | { state: 'unknown'; reason: string }

export type TaskBranchLandingDecision =
  | { action: 'skip'; number?: number }
  | { action: 'keep' }
  | { action: 'refuse'; cause: 'unknown'; reason: string; branch: string; tip: string }
  | {
      action: 'refuse'
      cause: 'closed-unmerged'
      pullRequest: number
      branch: string
      tip: string
    }

export type TaskBranchLandingRefusal = Extract<TaskBranchLandingDecision, { action: 'refuse' }>

export class TaskBranchLandingRefusalError extends Error {
  readonly refusal: TaskBranchLandingRefusal

  constructor(refusal: TaskBranchLandingRefusal, trunk: string) {
    super(taskBranchLandingRefusalMessage(refusal, trunk))
    this.refusal = refusal
  }
}

/** Compose the operator-facing remedy after the landing decision refuses reuse. */
export function taskBranchLandingRefusalMessage(
  refusal: TaskBranchLandingRefusal,
  trunk: string,
): string {
  const reason =
    refusal.cause === 'closed-unmerged'
      ? `pull request #${refusal.pullRequest} was closed without merge`
      : `GitHub landing check could not complete: ${refusal.reason}`
  return (
    `refusing task branch ${refusal.branch} tip ${refusal.tip}: ` +
    `${reason}; ` +
    `rerun with --base ${refusal.branch} to continue from its content, ` +
    `or --base ${trunk} to start over`
  )
}

/** Decide whether dispatch may reuse one observed task branch. */
export function decideTaskBranchLanding(input: {
  branch: string
  tip: string
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
      cause: 'unknown',
      reason: input.pullRequestCheck.reason,
      branch: input.branch,
      tip: input.tip,
    }
  }
  if (input.pullRequestCheck.state === 'closed-unmerged') {
    return {
      action: 'refuse',
      cause: 'closed-unmerged',
      pullRequest: input.pullRequestCheck.number,
      branch: input.branch,
      tip: input.tip,
    }
  }
  return { action: 'keep' }
}

/** Decide the targeted GitHub evidence without performing either listing or Git check. */
export function decideTaskBranchPullRequestCheck(input: {
  nameListing: PullRequestListing
  commitListing: PullRequestListing
  nameCheck: PullRequestNameCheck<GitHubPullRequest>
  commitCheck: PullRequestCommitCheck
}): TaskBranchPullRequestCheck {
  if (input.nameCheck && 'error' in input.nameCheck) {
    return { state: 'unknown', reason: input.nameCheck.error }
  }
  if (input.nameCheck && 'pullRequest' in input.nameCheck && input.nameCheck.containsTip) {
    return { state: 'landed', landedBy: 'name', number: input.nameCheck.pullRequest.number }
  }
  if (input.commitCheck && 'error' in input.commitCheck) {
    return { state: 'unknown', reason: input.commitCheck.error }
  }
  if (input.commitCheck && 'number' in input.commitCheck) {
    return { state: 'landed', landedBy: 'pr-commits', number: input.commitCheck.number }
  }
  if (input.nameListing.truncated || input.commitListing.truncated) {
    return {
      state: 'unknown',
      reason:
        `targeted merged pull-request listing reached ${GH_TARGETED_MERGED_PR_LIMIT} entries ` +
        'and may be truncated',
    }
  }
  if (input.nameListing.pullRequests.some((pullRequest) => pullRequest.state === 'OPEN')) {
    return { state: 'unmatched' }
  }
  const closed = input.nameListing.pullRequests.find(
    (pullRequest) => pullRequest.state === 'CLOSED',
  )
  if (
    closed &&
    input.nameListing.pullRequests.every((pullRequest) => pullRequest.state === 'CLOSED')
  ) {
    return { state: 'closed-unmerged', number: closed.number }
  }
  return { state: 'unmatched' }
}

/** Observe whether a merged pull request contains one task branch's content. */
function taskBranchPullRequestCheck(input: {
  project: Project
  launchKey: string
  branch: string
  tip: string
}): TaskBranchPullRequestCheck {
  let nameListing: ReturnType<typeof targetedTaskBranchPullRequests>
  let commitListing: PullRequestListing<MergedPullRequest>
  try {
    nameListing = targetedTaskBranchPullRequests(input.project, input.branch)
    commitListing = targetedMergedPullRequests(input.project, { search: input.launchKey })
  } catch (error) {
    return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }
  }
  const namePullRequests = nameListing.pullRequests
  const commitPullRequests = commitListing.pullRequests.sort((left, right) =>
    (right.mergedAt ?? '').localeCompare(left.mergedAt ?? ''),
  )
  const fetched = new Map<number, string | null>()
  const nameCheck = pullRequestNameCheck(
    input.project,
    namePullRequests.filter((pullRequest) => pullRequest.state === 'MERGED'),
    input.branch,
    input.tip,
    fetched,
  )
  if ((nameCheck && 'error' in nameCheck) || nameCheck?.containsTip) {
    return decideTaskBranchPullRequestCheck({
      nameListing,
      commitListing,
      nameCheck,
      commitCheck: null,
    })
  }
  const commitCheck = pullRequestCommitCheck(
    input.project,
    commitPullRequests.filter((pullRequest) => pullRequestCarriesKey(pullRequest, input.launchKey)),
    input.tip,
    fetched,
  )
  return decideTaskBranchPullRequestCheck({
    nameListing,
    commitListing,
    nameCheck,
    commitCheck,
  })
}

export function taskBranchAlreadyLanded(input: {
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
    localCheck,
    pullRequestCheck: taskBranchPullRequestCheck(input),
  })
  if (landing.action === 'refuse') {
    throw new TaskBranchLandingRefusalError(landing, input.trunk)
  }
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

function preferredTaskBranchAlias<T extends { branch: string }>(
  aliases: readonly T[],
  launchKey: string,
): T {
  const keyed = aliases.find((candidate) => candidate.branch === launchKey)
  if (keyed) return keyed
  let preferred = aliases[0]!
  for (const candidate of aliases) {
    if (candidate.branch < preferred.branch) preferred = candidate
  }
  return preferred
}

/** Drop strict-ancestor tips and collapse equal-tip aliases to one live candidate. */
export function selectMaximalTaskBranchCandidates(
  candidates: readonly TaskBranchCandidate[],
  launchKey: string,
  containedTips: ReadonlySet<string>,
): TaskBranchCandidate[] {
  const live = candidates.filter((candidate) => !containedTips.has(candidate.tip))
  const selected: TaskBranchCandidate[] = []
  const seenTips = new Set<string>()
  for (const candidate of live) {
    if (seenTips.has(candidate.tip)) continue
    seenTips.add(candidate.tip)
    selected.push(
      preferredTaskBranchAlias(
        live.filter((alias) => alias.tip === candidate.tip),
        launchKey,
      ),
    )
  }
  return selected
}

function taskBranchGitReconciliationRemedies(candidates: readonly TaskBranchCandidate[]): string {
  return candidates
    .map((kept) => {
      const deletions = candidates
        .filter((candidate) => candidate !== kept)
        .map((candidate) => `    git branch -d ${candidate.branch}`)
        .join('\n')
      return `  To keep ${kept.branch}:\n    merge the other tips into ${kept.branch}, or\n${deletions}`
    })
    .join('\n')
}

function taskBranchScoreVoidRemedies(
  launchKey: string,
  candidates: readonly TaskBranchCandidate[],
): string {
  return candidates
    .map((kept) => {
      const voidCommands = candidates
        .filter((candidate) => candidate !== kept)
        .flatMap((candidate) => candidate.nominatingRuns.map((run) => run.id))
        .map((id) => `    orch score ${id} --void --note "not the live ${launchKey} branch"`)
        .join('\n')
      return `  To keep ${kept.branch}:\n${voidCommands}`
    })
    .join('\n')
}

/** Compose the operator-facing remedy when more than one maximal task branch remains. */
export function taskBranchAmbiguityRefusal(
  launchKey: string,
  trunk: string,
  candidates: readonly TaskBranchCandidate[],
): string {
  const detail = candidates
    .map(
      (candidate) => `  ${candidate.branch} tip ${candidate.tip} commits ${candidate.commitCount}`,
    )
    .join('\n')
  return (
    `refusing task branch resolution for ${launchKey}: more than one branch carries content not on ${trunk}\n` +
    `${detail}\n` +
    `invariant: A task owns one branch.\n` +
    `Reconcile in Git so one branch contains the intended content, then retry resolution.\n` +
    '`git branch -d` compares at the current tip and refuses an unmerged branch; do not use -D.\n' +
    `${taskBranchGitReconciliationRemedies(candidates)}\n` +
    `Void a nominating score only when that run's branch claim itself is false or stale:\n` +
    `${taskBranchScoreVoidRemedies(launchKey, candidates)}`
  )
}

export function taskBranchCandidacySql(runAlias = 'candidate'): string {
  return (
    `${runAlias}.status <> 'stopped' AND ` + `COALESCE(${runAlias}.failure_kind, '') <> 'abandoned'`
  )
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

function taskBranchIsAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  const process = Bun.spawnSync(
    ['git', '-C', cwd, 'merge-base', '--is-ancestor', ancestor, descendant],
    {
      env: targetGitEnvironment(cwd),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  if (process.exitCode === 0) return true
  if (process.exitCode === 1) return false
  throw new Error(
    'git merge-base --is-ancestor failed while resolving the task branch: ' +
      (process.stderr.toString().trim() || `exit ${process.exitCode}`),
  )
}

function taskBranchContainedTips(
  repoRoot: string,
  candidates: readonly Pick<TaskBranchCandidate, 'tip'>[],
): Set<string> {
  if (candidates.length < 2) return new Set()
  const tips = [...new Set(candidates.map((candidate) => candidate.tip))]
  const contained = new Set<string>()
  for (const tip of tips) {
    for (const other of tips) {
      if (tip === other) continue
      if (taskBranchIsAncestor(repoRoot, tip, other)) contained.add(tip)
    }
  }
  return contained
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
            candidate.launch_base, candidate.session_id, candidate.worktree,
            candidate.worktree_source
       FROM candidate
      WHERE candidate.launch_key=?
        AND (candidate.project_id=? OR (candidate.project_id IS NULL AND candidate.repo=?))
        AND candidate.branch IS NOT NULL
        AND ${taskBranchCandidacySql('candidate')}
        AND ${reviewRunEvidenceSql('candidate', 'candidate')}
      ORDER BY candidate.id`,
    )
    .all(launchKey, project.id, project.name) as (TaskBranchRunRow & {
    session_id: string | null
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
      nominatingRuns: branchRows.map((row) => ({ id: row.id, sessionId: row.session_id })),
      trunk,
      worktree: path
        ? {
            path,
            branch,
            base: tip,
            repoRoot,
            source:
              source === 'recipe' ||
              source === 'git' ||
              source === 'clone' ||
              source === 'readonly_recipe'
                ? source
                : undefined,
            // Null records that this run attached; it did not mint the task branch.
            mintedBranch: null,
          }
        : null,
    })
  }

  const maximal = selectMaximalTaskBranchCandidates(
    candidates,
    launchKey,
    taskBranchContainedTips(repoRoot, candidates),
  )
  if (maximal.length === 0) return null
  if (maximal.length === 1) return maximal[0]!
  throw new Error(taskBranchAmbiguityRefusal(launchKey, trunk, maximal))
}

/** Compose the dispatch notice for deliberate reuse of an unlanded task branch. */
export function taskBranchReuseNotice(candidate: TaskBranchCandidate): string {
  return (
    `! continuing task branch ${candidate.branch} at tip ${candidate.tip} ` +
    `(runs ${candidate.nominatingRuns.map((run) => run.id).join(', ')}); ` +
    `use --base ${candidate.trunk} to start over`
  )
}
