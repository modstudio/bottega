// concern: merged-pull-request
/** Lists merged pull requests and checks whether branch content landed through one. */

import { targetGitEnvironment } from '../git/git-environment.ts'
import type { Project } from '../project/projects.ts'

export const GH_MERGED_PR_LIMIT = 1000

export type MergedPullRequest = {
  number: number
  headRefName: string
  headRefOid: string
  title: string
  mergeCommit: { oid: string } | null
  mergedAt: string
}

export type PullRequestCommitCheck = { number: number } | { error: string } | null

export type PullRequestNameCheck =
  | { pullRequest: MergedPullRequest; containsTip: boolean }
  | { error: string }
  | null

function command(cwd: string, argv: string[], label: string): string {
  let process: ReturnType<typeof Bun.spawnSync>
  try {
    // Output is parsed, so a forced-colour environment must not reach gh or git.
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

function isMergedPullRequest(value: unknown): value is MergedPullRequest {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  const mergeCommit = row.mergeCommit
  return (
    Number.isInteger(row.number) &&
    typeof row.headRefName === 'string' &&
    typeof row.headRefOid === 'string' &&
    typeof row.title === 'string' &&
    typeof row.mergedAt === 'string' &&
    (mergeCommit === null ||
      (typeof mergeCommit === 'object' &&
        mergeCommit !== null &&
        typeof (mergeCommit as Record<string, unknown>).oid === 'string'))
  )
}

export function mergedPullRequests(project: Project): {
  pullRequests: MergedPullRequest[]
  truncated: boolean
} {
  const output = command(
    project.path,
    [
      'gh',
      'pr',
      'list',
      '--state',
      'merged',
      '--limit',
      String(GH_MERGED_PR_LIMIT),
      '--json',
      'number,headRefName,headRefOid,title,mergeCommit,mergedAt',
    ],
    'merged pull-request listing',
  )
  let value: unknown
  try {
    value = JSON.parse(output || '[]')
  } catch (error) {
    throw new Error(
      `merged pull-request listing returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!Array.isArray(value) || !value.every(isMergedPullRequest)) {
    throw new Error('merged pull-request listing returned an unexpected JSON shape')
  }
  return { pullRequests: value, truncated: value.length === GH_MERGED_PR_LIMIT }
}

function fetchPullRequest(project: Project, pullRequest: MergedPullRequest): string | null {
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
  pullRequest: MergedPullRequest,
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

export function pullRequestNameCheck(
  project: Project,
  pullRequests: readonly MergedPullRequest[],
  branch: string,
  branchTip: string,
  fetched: Map<number, string | null>,
): PullRequestNameCheck {
  let failure: string | null = null
  let mismatch: MergedPullRequest | null = null
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
