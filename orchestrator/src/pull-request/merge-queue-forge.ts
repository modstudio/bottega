// concern: GitHub merge-queue adapter
/** Reads and mutates GitHub's merge queue without owning merge policy. */

import { targetGitEnvironment } from '../git/git-environment.ts'
import { isPullRequestMergeGroupRun } from './merge-group-run.ts'
import type { MergeQueueObservation } from './merge-queue-decision.ts'

export type FailedMergeGroupRun = {
  id: number
  url: string
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
      'query=query($id:ID!){node(id:$id){... on PullRequest{state mergeCommit{oid} mergeQueueEntry{state}}}}',
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
        mergeQueueEntry?: { state?: unknown } | null
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
  if (
    !node ||
    typeof node.state !== 'string' ||
    node.mergeCommit === undefined ||
    (node.mergeCommit !== null && typeof mergeCommit !== 'string') ||
    node.mergeQueueEntry === undefined ||
    (node.mergeQueueEntry !== null && typeof entryState !== 'string')
  ) {
    throw new Error('merge-queue lookup returned an unexpected JSON shape')
  }
  return {
    pullRequestState: node.state,
    mergeCommit: typeof mergeCommit === 'string' ? mergeCommit : null,
    entryState: typeof entryState === 'string' ? entryState : null,
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

function workflowRunPage(output: string): unknown[] {
  let value: { workflow_runs?: unknown }
  try {
    value = JSON.parse(output) as typeof value
  } catch (cause) {
    throw new Error(
      `failed merge-group run lookup returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  if (!Array.isArray(value.workflow_runs)) {
    throw new Error('failed merge-group run lookup returned an unexpected JSON shape')
  }
  return value.workflow_runs
}

function failedMergeGroupRunFrom(
  raw: unknown,
  baseBranch: string,
  pullRequestNumber: number,
): FailedMergeGroupRun | null {
  if (!isPullRequestMergeGroupRun(raw, baseBranch, pullRequestNumber)) return null
  if (raw.conclusion !== 'failure') return null
  if (!Number.isSafeInteger(raw.id) || typeof raw.html_url !== 'string') {
    throw new Error('failed merge-group run lookup returned an unexpected run shape')
  }
  return { id: Number(raw.id), url: raw.html_url }
}

export function failedMergeGroupRunFromPages(
  fetchPage: (page: number) => unknown[],
  baseBranch: string,
  pullRequestNumber: number,
): FailedMergeGroupRun | null {
  for (let page = 1; ; page += 1) {
    const batch = fetchPage(page)
    for (const raw of batch) {
      const match = failedMergeGroupRunFrom(raw, baseBranch, pullRequestNumber)
      if (match) return match
    }
    if (batch.length < 100) return null
  }
}

export function githubFailedMergeGroupRun(
  cwd: string,
  repository: string,
  baseBranch: string,
  pullRequestNumber: number,
): FailedMergeGroupRun | null {
  return failedMergeGroupRunFromPages(
    (page) =>
      workflowRunPage(
        successful(
          cwd,
          [
            'gh',
            'api',
            '--method',
            'GET',
            `repos/${repository}/actions/runs`,
            '-f',
            'event=merge_group',
            '-f',
            'per_page=100',
            '-f',
            `page=${page}`,
          ],
          'failed merge-group run lookup',
        ),
      ),
    baseBranch,
    pullRequestNumber,
  )
}
