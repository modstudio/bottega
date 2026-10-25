// concern: GitHub merge-queue adapter
/** Reads and mutates GitHub's merge queue without owning merge policy. */

import { targetGitEnvironment } from '../git/git-environment.ts'
import { githubWorkflowRuns } from './github-actions.ts'
import { isPullRequestMergeGroupRun } from './merge-group-run.ts'
import type { MergeQueueObservation } from './merge-queue-decision.ts'

export type FailedMergeGroupRun = {
  id: number
  url: string
  conclusion: string
}

function successful(cwd: string, argv: string[], label: string): string {
  const result = Bun.spawnSync(argv, {
    cwd,
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`,
    )
  }
  return result.stdout.toString().trim()
}

export function githubMergeQueueState(cwd: string, nodeId: string): MergeQueueObservation {
  const output = successful(
    cwd,
    [
      'gh',
      'api',
      'graphql',
      '-f',
      'query=query($id:ID!){node(id:$id){... on PullRequest{state mergeCommit{oid} mergeQueueEntry{state enqueuedAt}}}}',
      '-f',
      `id=${nodeId}`,
    ],
    'merge-queue lookup',
  )
  let value: {
    data?: {
      node?: {
        state?: unknown
        mergeCommit?: { oid?: unknown } | null
        mergeQueueEntry?: { state?: unknown; enqueuedAt?: unknown } | null
      } | null
    }
  }
  try {
    value = JSON.parse(output) as typeof value
  } catch (cause) {
    throw new Error(
      `merge-queue lookup returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  const node = value.data?.node
  const mergeCommit = node?.mergeCommit?.oid
  const entryState = node?.mergeQueueEntry?.state
  const enqueuedAt = node?.mergeQueueEntry?.enqueuedAt
  if (
    !node ||
    typeof node.state !== 'string' ||
    node.mergeCommit === undefined ||
    (node.mergeCommit !== null && typeof mergeCommit !== 'string') ||
    node.mergeQueueEntry === undefined ||
    (node.mergeQueueEntry !== null &&
      (typeof entryState !== 'string' ||
        enqueuedAt === undefined ||
        (enqueuedAt !== null && typeof enqueuedAt !== 'string')))
  ) {
    throw new Error('merge-queue lookup returned an unexpected JSON shape')
  }
  return {
    pullRequestState: node.state,
    mergeCommit: typeof mergeCommit === 'string' ? mergeCommit : null,
    entryState: typeof entryState === 'string' ? entryState : null,
    enqueuedAt: typeof enqueuedAt === 'string' ? enqueuedAt : null,
  }
}

export function enqueuePullRequest(cwd: string, number: number, headCommit: string): void {
  successful(
    cwd,
    ['gh', 'pr', 'merge', String(number), '--auto', '--match-head-commit', headCommit],
    'merge-queue enqueue',
  )
}

export function requeuePullRequest(cwd: string, nodeId: string, headCommit: string): void {
  successful(
    cwd,
    [
      'gh',
      'api',
      'graphql',
      '-f',
      'query=mutation($id:ID!){dequeuePullRequest(input:{id:$id}){clientMutationId}}',
      '-f',
      `id=${nodeId}`,
    ],
    'merge-queue dequeue',
  )
  successful(
    cwd,
    [
      'gh',
      'api',
      'graphql',
      '-f',
      'query=mutation($pullRequestId:ID!,$expectedHeadOid:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$pullRequestId,expectedHeadOid:$expectedHeadOid}){clientMutationId}}',
      '-f',
      `pullRequestId=${nodeId}`,
      '-f',
      `expectedHeadOid=${headCommit}`,
    ],
    'merge-queue re-enqueue',
  )
}

function failedMergeGroupRunFrom(
  raw: unknown,
  baseBranch: string,
  pullRequestNumber: number,
): (FailedMergeGroupRun & { createdAt: string }) | null {
  if (!isPullRequestMergeGroupRun(raw, baseBranch, pullRequestNumber)) return null
  if (raw.status !== 'completed') return null
  if (['success', 'skipped', 'neutral'].includes(String(raw.conclusion))) return null
  if (
    typeof raw.conclusion !== 'string' ||
    !Number.isSafeInteger(raw.id) ||
    typeof raw.html_url !== 'string' ||
    typeof raw.created_at !== 'string'
  ) {
    throw new Error('failed merge-group run lookup returned an unexpected run shape')
  }
  return {
    id: Number(raw.id),
    url: raw.html_url,
    conclusion: raw.conclusion,
    createdAt: raw.created_at,
  }
}

export function failedMergeGroupRunFromRuns(
  runs: readonly unknown[],
  baseBranch: string,
  pullRequestNumber: number,
): FailedMergeGroupRun | null {
  const matches = runs.flatMap((raw) => {
    const match = failedMergeGroupRunFrom(raw, baseBranch, pullRequestNumber)
    return match ? [match] : []
  })
  matches.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const match = matches[0]
  return match ? { id: match.id, url: match.url, conclusion: match.conclusion } : null
}

export function githubFailedMergeGroupRun(
  cwd: string,
  repository: string,
  baseBranch: string,
  pullRequestNumber: number,
  enqueuedAt: string,
): FailedMergeGroupRun | null {
  return failedMergeGroupRunFromRuns(
    githubWorkflowRuns(cwd, repository, {
      event: 'merge_group',
      created: `>=${enqueuedAt}`,
    }),
    baseBranch,
    pullRequestNumber,
  )
}
