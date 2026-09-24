// concern: merged-pull-request
/** Lists merged pull requests and checks whether branch content landed through one. */

import { targetGitEnvironment } from '../git/git-environment.ts'
import type { Project } from '../project/projects.ts'

export const GH_MERGED_PR_LIMIT = 1000
export const GH_TARGETED_MERGED_PR_LIMIT = 100

export type GitHubPullRequest = {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  headRefName: string
  headRefOid: string
  title: string
  mergeCommit: { oid: string } | null
  mergedAt: string | null
}

export type MergedPullRequest = GitHubPullRequest & { state: 'MERGED'; mergedAt: string }

export type PullRequestCommitCheck = { number: number } | { error: string } | null

type PullRequestHead = Pick<GitHubPullRequest, 'number' | 'headRefName' | 'headRefOid'>

export type PullRequestNameCheck<T extends PullRequestHead = MergedPullRequest> =
  | { pullRequest: T; containsTip: boolean }
  | { error: string }
  | null

function command(cwd: string, argv: string[], label: string): string {
  let process: ReturnType<typeof Bun.spawnSync>
  try {
    // Output is parsed, so a forced-color environment must not reach gh or git.
    const { FORCE_COLOR: _force, CLICOLOR_FORCE: _clicolor, ...env } = targetGitEnvironment(cwd)
    process = Bun.spawnSync(argv, {
      cwd,
      env: { ...env, NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (error) {
    throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (process.exitCode !== 0) {
    throw new Error(
      `${label} failed: ${process.stderr?.toString().trim() || `exit ${process.exitCode}`}`,
    )
  }
  return process.stdout?.toString().trim() ?? ''
}

function git(cwd: string, ...args: string[]): string {
  return command(cwd, ['git', ...args], `git ${args.join(' ')}`)
}

function hasPullRequestFields(row: Record<string, unknown>): boolean {
  const mergeCommit = row.mergeCommit
  return (
    Number.isInteger(row.number) &&
    typeof row.headRefName === 'string' &&
    typeof row.headRefOid === 'string' &&
    typeof row.title === 'string' &&
    (mergeCommit === null ||
      (typeof mergeCommit === 'object' &&
        mergeCommit !== null &&
        typeof (mergeCommit as Record<string, unknown>).oid === 'string'))
  )
}

function isGitHubPullRequest(value: unknown): value is GitHubPullRequest {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return (
    hasPullRequestFields(row) &&
    (row.state === 'OPEN' || row.state === 'CLOSED' || row.state === 'MERGED') &&
    (typeof row.mergedAt === 'string' || row.mergedAt === null)
  )
}

export type PullRequestListing<T extends GitHubPullRequest = GitHubPullRequest> = {
  pullRequests: T[]
  truncated: boolean
}

/** Validate and classify one GitHub listing at its caller-selected limit. */
export function pullRequestListing(value: unknown, limit: number): PullRequestListing {
  if (!Array.isArray(value) || !value.every(isGitHubPullRequest)) {
    throw new Error('pull-request listing returned an unexpected JSON shape')
  }
  return { pullRequests: value, truncated: value.length === limit }
}

function listPullRequests(
  project: Project,
  filters: readonly string[],
  limit: number,
  state: 'merged',
  json: string,
): PullRequestListing<MergedPullRequest>
function listPullRequests(
  project: Project,
  filters: readonly string[],
  limit: number,
  state: 'all',
  json: string,
): PullRequestListing
function listPullRequests(
  project: Project,
  filters: readonly string[],
  limit: number,
  state: 'all' | 'merged',
  json: string,
): PullRequestListing {
  const output = command(
    project.path,
    ['gh', 'pr', 'list', '--state', state, ...filters, '--limit', String(limit), '--json', json],
    'pull-request listing',
  )
  let value: unknown
  try {
    value = JSON.parse(output || '[]')
  } catch (error) {
    throw new Error(
      `pull-request listing returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const listing = pullRequestListing(value, limit)
  if (
    state === 'merged' &&
    listing.pullRequests.some(
      (pullRequest) => pullRequest.state !== 'MERGED' || pullRequest.mergedAt === null,
    )
  ) {
    throw new Error('pull-request listing returned a non-merged row for --state merged')
  }
  return listing as PullRequestListing<MergedPullRequest>
}

const PULL_REQUEST_JSON = 'number,state,headRefName,headRefOid,title,mergeCommit,mergedAt'

export function mergedPullRequests(project: Project): PullRequestListing<MergedPullRequest> {
  return listPullRequests(project, [], GH_MERGED_PR_LIMIT, 'merged', PULL_REQUEST_JSON)
}

export function targetedMergedPullRequests(
  project: Project,
  filter: { head: string } | { search: string },
): PullRequestListing<MergedPullRequest> {
  const filters = 'head' in filter ? ['--head', filter.head] : ['--search', filter.search]
  return listPullRequests(
    project,
    filters,
    GH_TARGETED_MERGED_PR_LIMIT,
    'merged',
    PULL_REQUEST_JSON,
  )
}

/** List every pull-request state for one exact head branch. */
export function targetedTaskBranchPullRequests(
  project: Project,
  branch: string,
): PullRequestListing {
  return listPullRequests(
    project,
    ['--head', branch],
    GH_TARGETED_MERGED_PR_LIMIT,
    'all',
    PULL_REQUEST_JSON,
  )
}

function fetchPullRequest(project: Project, pullRequest: PullRequestHead): string | null {
  try {
    git(
      project.path,
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      'origin',
      pullRequest.headRefOid,
    )
    return null
  } catch (shaError) {
    try {
      git(
        project.path,
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        'origin',
        `refs/pull/${pullRequest.number}/head`,
      )
      return null
    } catch (refError) {
      return `PR #${pullRequest.number} fetch failed by SHA (${String(shaError)}) and pull ref (${String(refError)})`
    }
  }
}

function fetchPullRequestCached(
  project: Project,
  pullRequest: PullRequestHead,
  fetched: Map<number, string | null>,
): string | null {
  let failure = fetched.get(pullRequest.number)
  if (failure === undefined) {
    failure = fetchPullRequest(project, pullRequest)
    fetched.set(pullRequest.number, failure)
  }
  return failure
}

export function pullRequestCommitCheck(
  project: Project,
  pullRequests: readonly MergedPullRequest[],
  branchTip: string,
  fetched: Map<number, string | null>,
): PullRequestCommitCheck {
  let failure: string | null = null
  for (const pullRequest of pullRequests) {
    const fetchFailure = fetchPullRequestCached(project, pullRequest, fetched)
    if (fetchFailure) {
      failure ??= fetchFailure
      continue
    }
    try {
      const cherry = git(project.path, 'cherry', pullRequest.headRefOid, branchTip)
      if (!cherry.split('\n').some((line) => line.startsWith('+'))) {
        return { number: pullRequest.number }
      }
    } catch (error) {
      failure ??= `PR #${pullRequest.number} commit check failed: ${String(error)}`
    }
  }
  return failure ? { error: failure } : null
}

export function pullRequestNameCheck<T extends PullRequestHead>(
  project: Project,
  pullRequests: readonly T[],
  branch: string,
  branchTip: string,
  fetched: Map<number, string | null>,
): PullRequestNameCheck<T> {
  let failure: string | null = null
  let mismatch: T | null = null
  for (const pullRequest of pullRequests.filter((candidate) => candidate.headRefName === branch)) {
    const fetchFailure = fetchPullRequestCached(project, pullRequest, fetched)
    if (fetchFailure) {
      failure ??= fetchFailure
      continue
    }
    try {
      const mergeBase = git(project.path, 'merge-base', branchTip, pullRequest.headRefOid)
      if (mergeBase === branchTip) return { pullRequest, containsTip: true }
      mismatch = pullRequest
    } catch (error) {
      failure ??= `PR #${pullRequest.number} head containment check failed: ${String(error)}`
    }
  }
  if (failure) return { error: failure }
  return mismatch ? { pullRequest: mismatch, containsTip: false } : null
}
