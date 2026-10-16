// concern: merge-queue decision
/** Interprets forge queue facts and decides whether a merge command is still needed. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type MergeQueueObservation = {
  pullRequestState: string
  mergeCommit: string | null
  entryState: string | null
}

export type MergeQueueState =
  | { state: 'merged'; mergeCommit: string }
  | { state: 'queued' }
  | { state: 'dequeued' }
  | { state: 'failed' }
  | { state: 'unknown'; detail: string }

export type MergeQueueAction =
  | { action: 'complete'; mergeCommit: string }
  | { action: 'enqueue' }
  | { action: 'wait' }
  | { action: 'refuse'; refusal: string }

const ACTIVE_ENTRY_STATES = new Set(['AWAITING_CHECKS', 'LOCKED', 'MERGEABLE', 'QUEUED'])

export function interpretMergeQueue(observation: MergeQueueObservation): MergeQueueState {
  const pullRequestState = observation.pullRequestState.toUpperCase()
  const entryState = observation.entryState?.toUpperCase() ?? null
  if (pullRequestState === 'MERGED' && observation.mergeCommit) {
    return { state: 'merged', mergeCommit: observation.mergeCommit }
  }
  if (pullRequestState === 'CLOSED') return { state: 'dequeued' }
  if (pullRequestState === 'OPEN' && entryState === 'UNMERGEABLE') return { state: 'failed' }
  if (pullRequestState === 'OPEN' && entryState && ACTIVE_ENTRY_STATES.has(entryState)) {
    return { state: 'queued' }
  }
  if (pullRequestState === 'OPEN' && entryState === null) return { state: 'dequeued' }
  return {
    state: 'unknown',
    detail: `pull request state ${observation.pullRequestState}, queue entry ${observation.entryState ?? 'none'}, merge commit ${observation.mergeCommit ?? 'none'}`,
  }
}

export function decideMergeQueueAction(
  number: number,
  queue: MergeQueueState,
  queueEstablished: boolean,
): MergeQueueAction {
  const retry = `${PLATFORM_SLUG} pr merge ${number}`
  if (queue.state === 'merged') {
    return { action: 'complete', mergeCommit: queue.mergeCommit }
  }
  if (queue.state === 'queued') return { action: 'wait' }
  if (queue.state === 'dequeued' && !queueEstablished) return { action: 'enqueue' }
  if (queue.state === 'dequeued') {
    return {
      action: 'refuse',
      refusal: `pull request #${number} left the merge queue without merging; cleared by: fix the dequeue reason, then ${retry}`,
    }
  }
  if (queue.state === 'failed') {
    return {
      action: 'refuse',
      refusal: `pull request #${number} failed in the merge queue; cleared by: fix the merge-group check or conflict, then ${retry}`,
    }
  }
  return {
    action: 'refuse',
    refusal: `pull request #${number} has an unknown merge-queue state (${queue.detail}); cleared by: inspect the pull request on GitHub, then ${retry}`,
  }
}
