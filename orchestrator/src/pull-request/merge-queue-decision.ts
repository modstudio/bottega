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
  | { state: 'closed' }
  | { state: 'failed' }
  | { state: 'unknown'; detail: string }

type MergeQueueAction =
  | { action: 'complete'; mergeCommit: string }
  | { action: 'enqueue' }
  | { action: 'wait'; delay: number }
  | { action: 'refuse'; refusal: string; remedy: string }

export type MergeQueueWaitState = {
  enqueueSubmitted: boolean
  activeEntryObserved: boolean
  dequeueObservedAt: number | null
}

export type MergeQueueStep = {
  state: MergeQueueWaitState
  action: MergeQueueAction
}

const ACTIVE_ENTRY_STATES = new Set(['AWAITING_CHECKS', 'LOCKED', 'MERGEABLE', 'QUEUED'])
export const MERGE_QUEUE_WAIT_MS = 30 * 60 * 1000
export const MERGE_QUEUE_DEQUEUE_CONFIRM_MS = 60 * 1000
const MERGE_QUEUE_POLL_MS = 10 * 1000

export function interpretMergeQueue(observation: MergeQueueObservation): MergeQueueState {
  const pullRequestState = observation.pullRequestState.toUpperCase()
  const entryState = observation.entryState?.toUpperCase() ?? null
  if (pullRequestState === 'MERGED' && observation.mergeCommit) {
    return { state: 'merged', mergeCommit: observation.mergeCommit }
  }
  if (pullRequestState === 'CLOSED') return { state: 'closed' }
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

export function stepMergeQueueWait(
  number: number,
  previous: MergeQueueWaitState,
  queue: MergeQueueState,
  now: number,
  deadline: number,
): MergeQueueStep {
  let state = previous
  if (queue.state === 'queued') {
    state = { ...state, activeEntryObserved: true, dequeueObservedAt: null }
  } else if (
    queue.state === 'dequeued' &&
    state.activeEntryObserved &&
    state.dequeueObservedAt === null
  ) {
    state = { ...state, dequeueObservedAt: now }
  }

  const retry = `${PLATFORM_SLUG} pr merge ${number}`
  if (queue.state === 'merged') {
    return { state, action: { action: 'complete', mergeCommit: queue.mergeCommit } }
  }
  if (queue.state === 'closed') {
    return {
      state,
      action: {
        action: 'refuse',
        refusal: `pull request #${number} left the merge queue without merging`,
        remedy: `fix the dequeue reason, then ${retry}`,
      },
    }
  }
  if (queue.state === 'failed') {
    return {
      state,
      action: {
        action: 'refuse',
        refusal: `pull request #${number} failed in the merge queue`,
        remedy: `fix the merge-group check or conflict, then ${retry}`,
      },
    }
  }
  if (queue.state === 'unknown') {
    return {
      state,
      action: {
        action: 'refuse',
        refusal: `pull request #${number} has an unknown merge-queue state (${queue.detail})`,
        remedy: `inspect the pull request on GitHub, then ${retry}`,
      },
    }
  }
  if (now >= deadline) {
    return {
      state,
      action: {
        action: 'refuse',
        refusal: `pull request #${number} did not merge within ${MERGE_QUEUE_WAIT_MS}ms`,
        remedy: `re-run ${retry}, which will keep waiting if it is already queued`,
      },
    }
  }
  if (
    queue.state === 'dequeued' &&
    state.activeEntryObserved &&
    state.dequeueObservedAt !== null &&
    now - state.dequeueObservedAt >= MERGE_QUEUE_DEQUEUE_CONFIRM_MS
  ) {
    return {
      state,
      action: {
        action: 'refuse',
        refusal: `pull request #${number} left the merge queue without merging`,
        remedy: `fix the dequeue reason, then ${retry}`,
      },
    }
  }
  if (queue.state === 'dequeued' && !state.enqueueSubmitted && !state.activeEntryObserved) {
    state = { ...state, enqueueSubmitted: true }
    return { state, action: { action: 'enqueue' } }
  }
  const dequeueConfirmationRemaining =
    queue.state === 'dequeued' && state.activeEntryObserved && state.dequeueObservedAt !== null
      ? MERGE_QUEUE_DEQUEUE_CONFIRM_MS - (now - state.dequeueObservedAt)
      : Number.POSITIVE_INFINITY
  return {
    state,
    action: {
      action: 'wait',
      delay: Math.min(MERGE_QUEUE_POLL_MS, deadline - now, dequeueConfirmationRemaining),
    },
  }
}

export function mergeQueueEnqueueFailureRemedy(number: number, message: string): string {
  const retry = `${PLATFORM_SLUG} pr merge ${number}`
  const normalized = message.toLowerCase()
  if (
    normalized.includes('enablepullrequestautomerge') ||
    normalized.includes('auto merge is not allowed')
  ) {
    return `enable auto-merge on the repository (allow_auto_merge), then ${retry}`
  }
  return `fix the reported forge condition, then ${retry}`
}
