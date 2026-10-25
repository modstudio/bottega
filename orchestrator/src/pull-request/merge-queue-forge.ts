// concern: GitHub merge-queue adapter
/** Reads and mutates GitHub's merge queue without owning merge policy. */

import { githubCommand, githubGraphql, githubWorkflowRuns } from './github-actions.ts'
import { type FailedMergeGroupRun, failedMergeGroupRunFromRuns } from './merge-group-run.ts'
import type { MergeQueueObservation } from './merge-queue-decision.ts'

export function githubMergeQueueState(cwd: string, nodeId: string): MergeQueueObservation {
  const value = githubGraphql(
    cwd,
    'query($id:ID!){node(id:$id){... on PullRequest{state mergeCommit{oid} mergeQueueEntry{state enqueuedAt}}}}',
    [`id=${nodeId}`],
    'merge-queue lookup',
  ) as {
    data?: {
      node?: {
        state?: unknown
        mergeCommit?: { oid?: unknown } | null
        mergeQueueEntry?: { state?: unknown; enqueuedAt?: unknown } | null
      } | null
    }
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
  githubCommand(
    cwd,
    ['pr', 'merge', String(number), '--auto', '--match-head-commit', headCommit],
    'merge-queue enqueue',
  )
}

export function requeuePullRequest(cwd: string, nodeId: string, headCommit: string): void {
  githubGraphql(
    cwd,
    'mutation($id:ID!){dequeuePullRequest(input:{id:$id}){clientMutationId}}',
    [`id=${nodeId}`],
    'merge-queue dequeue',
  )
  githubGraphql(
    cwd,
    'mutation($pullRequestId:ID!,$expectedHeadOid:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$pullRequestId,expectedHeadOid:$expectedHeadOid}){clientMutationId}}',
    [`pullRequestId=${nodeId}`, `expectedHeadOid=${headCommit}`],
    'merge-queue re-enqueue',
  )
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
