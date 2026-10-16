// concern: GitHub merge-queue adapter
/** Reads and mutates GitHub's merge queue without owning merge policy. */

import { targetGitEnvironment } from '../git/git-environment.ts'
import type { MergeQueueObservation } from './merge-queue-decision.ts'

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
  successful(cwd, enqueuePullRequestArguments(number, headCommit), 'merge-queue enqueue')
}

export function enqueuePullRequestArguments(number: number, headCommit: string): string[] {
  return ['gh', 'pr', 'merge', String(number), '--auto', '--match-head-commit', headCommit]
}
