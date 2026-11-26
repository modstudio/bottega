// concern: GitHub merge-queue adapter
/** Reads and mutates GitHub's merge queue without owning merge policy. */

import { githubApi, githubCommand, githubGraphql, githubWorkflowRuns } from './github-actions.ts'
import { type FailedMergeGroupRun, failedMergeGroupRunFromRuns } from './merge-group-run.ts'
import type { MergeQueueObservation } from './merge-queue-decision.ts'

export function githubMergeQueueState(cwd: string, nodeId: string): MergeQueueObservation {
  const value = githubGraphql(
    cwd,
    'query($id:ID!){node(id:$id){... on PullRequest{state mergeCommit{oid} mergeQueueEntry{state enqueuedAt} timelineItems(last:1,itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT]){nodes{... on RemovedFromMergeQueueEvent{reason createdAt}}}}}}',
    [`id=${nodeId}`],
    'merge-queue lookup',
  ) as {
    data?: {
      node?: {
        state?: unknown
        mergeCommit?: { oid?: unknown } | null
        mergeQueueEntry?: { state?: unknown; enqueuedAt?: unknown } | null
        timelineItems?: {
          nodes?: Array<{ reason?: unknown; createdAt?: unknown } | null> | null
        } | null
      } | null
    }
  }
  const node = value.data?.node
  const mergeCommit = node?.mergeCommit?.oid
  const entryState = node?.mergeQueueEntry?.state
  const enqueuedAt = node?.mergeQueueEntry?.enqueuedAt
  const removalReason = node?.timelineItems?.nodes?.at(-1)?.reason
  const removedAt = node?.timelineItems?.nodes?.at(-1)?.createdAt
  if (
    !node ||
    typeof node.state !== 'string' ||
    node.mergeCommit === undefined ||
    (node.mergeCommit !== null && typeof mergeCommit !== 'string') ||
    node.mergeQueueEntry === undefined ||
    node.timelineItems === undefined ||
    (node.mergeQueueEntry !== null &&
      (typeof entryState !== 'string' ||
        enqueuedAt === undefined ||
        (enqueuedAt !== null && typeof enqueuedAt !== 'string'))) ||
    (removalReason !== undefined && typeof removalReason !== 'string') ||
    (removedAt !== undefined && typeof removedAt !== 'string')
  ) {
    throw new Error('merge-queue lookup returned an unexpected JSON shape')
  }
  return {
    pullRequestState: node.state,
    mergeCommit: typeof mergeCommit === 'string' ? mergeCommit : null,
    entryState: typeof entryState === 'string' ? entryState : null,
    enqueuedAt: typeof enqueuedAt === 'string' ? enqueuedAt : null,
    removalReason: typeof removalReason === 'string' ? removalReason : null,
    removedAt: typeof removedAt === 'string' ? removedAt : null,
  }
}

export function githubLandingComparison(
  cwd: string,
  repository: string,
  landingBranch: string,
  mergeCommit: string,
): string {
  const value = githubApi(
    cwd,
    `repos/${repository}/compare/${encodeURIComponent(landingBranch)}...${encodeURIComponent(mergeCommit)}`,
  ) as { status?: unknown }
  if (typeof value.status !== 'string') {
    throw new Error('landing comparison returned an unexpected JSON shape')
  }
  return value.status.toLowerCase()
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
