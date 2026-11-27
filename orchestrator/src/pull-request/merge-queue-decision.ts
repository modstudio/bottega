// concern: merge-queue decision
/** Interprets forge queue facts and decides whether a merge command is still needed. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type MergeQueueObservation = {
  pullRequestState: string
  mergeCommit: string | null
  entryState: string | null
  enqueuedAt: string | null
  removalReason?: string | null
  removedAt?: string | null
}

export type MergeQueueState =
  | { state: 'merged'; mergeCommit: string }
  | { state: 'merged-without-commit' }
  | { state: 'queued' }
  | { state: 'dequeued'; reason: string }
  | { state: 'closed' }
  | { state: 'failed' }
  | { state: 'unknown'; detail: string }

type MergeQueueAction =
  | { action: 'complete'; mergeCommit: string }
  | { action: 'verify-landing'; mergeCommit: string }
  | { action: 'enqueue' }
  | { action: 'requeue' }
  | { action: 'wait'; delay: number }
  | {
      action: 'refuse'
      refusal: string
      remedy: string
      source?: 'dequeue-reason' | 'failed-check'
    }

export type MergeQueueWaitState = {
  enqueueSubmitted: boolean
  enqueueSubmittedAt: number | null
  activeEntryObserved: boolean
  dequeueObservedAt: number | null
  requeuePendingSince: number | null
  closedObservedAt: number | null
}

export type MergeQueueStep = {
  state: MergeQueueWaitState
  action: MergeQueueAction
}

const ACTIVE_ENTRY_STATES = new Set(['AWAITING_CHECKS', 'LOCKED', 'MERGEABLE', 'QUEUED'])
export const MERGE_QUEUE_WAIT_MS = 30 * 60 * 1000
export const MERGE_QUEUE_DEQUEUE_CONFIRM_MS = 60 * 1000
export const MERGE_QUEUE_REQUEUE_CONFIRM_MS = 60 * 1000
const MERGE_QUEUE_CLOSED_REPOLL_MS = 30 * 1000
const MERGE_QUEUE_POLL_MS = 10 * 1000

function failedMergeQueueStep(
  number: number,
  state: MergeQueueWaitState,
  now: number,
  deadline: number,
): MergeQueueStep {
  if (!state.enqueueSubmitted && !state.activeEntryObserved) {
    const requeued = { ...state, enqueueSubmitted: true, requeuePendingSince: now }
    return { state: requeued, action: { action: 'requeue' } }
  }
  if (
    state.requeuePendingSince !== null &&
    now < deadline &&
    now - state.requeuePendingSince < MERGE_QUEUE_REQUEUE_CONFIRM_MS
  ) {
    return {
      state,
      action: {
        action: 'wait',
        delay: Math.min(
          MERGE_QUEUE_POLL_MS,
          deadline - now,
          MERGE_QUEUE_REQUEUE_CONFIRM_MS - (now - state.requeuePendingSince),
        ),
      },
    }
  }
  const retry = `${PLATFORM_SLUG} pr merge ${number}`
  return {
    state,
    action: {
      action: 'refuse',
      refusal: `pull request #${number} failed in the merge queue`,
      remedy: `push a fix if the check failure is real, or re-run ${retry} to requeue the unchanged head if it flaked`,
      source: 'failed-check',
    },
  }
}

function observedMergeQueueState(
  previous: MergeQueueWaitState,
  queue: MergeQueueState,
  now: number,
): MergeQueueWaitState {
  if (queue.state === 'queued') {
    return {
      ...previous,
      activeEntryObserved: true,
      dequeueObservedAt: null,
      requeuePendingSince: null,
      closedObservedAt: null,
    }
  }
  if (queue.state === 'dequeued' && previous.requeuePendingSince !== null) {
    return { ...previous, requeuePendingSince: null }
  }
  if (
    queue.state === 'dequeued' &&
    (previous.activeEntryObserved || (previous.enqueueSubmitted && queue.reason !== 'unknown')) &&
    previous.dequeueObservedAt === null
  ) {
    return { ...previous, dequeueObservedAt: now }
  }
  return previous
}

function removalReason(
  observation: MergeQueueObservation,
  lastEnqueuedAt: string | null,
  enqueueSubmittedAt: number | null,
): string {
  const observedEnqueue = lastEnqueuedAt ? Date.parse(lastEnqueuedAt) : Number.NEGATIVE_INFINITY
  const submittedEnqueue = enqueueSubmittedAt ?? Number.NEGATIVE_INFINITY
  const removedAt = observation.removedAt ? Date.parse(observation.removedAt) : null
  return removedAt !== null && removedAt < Math.max(observedEnqueue, submittedEnqueue)
    ? 'unknown'
    : (observation.removalReason ?? 'unknown')
}

export function interpretMergeQueue(
  observation: MergeQueueObservation,
  lastEnqueuedAt: string | null = null,
  enqueueSubmittedAt: number | null = null,
): MergeQueueState {
  const pullRequestState = observation.pullRequestState.toUpperCase()
  const entryState = observation.entryState?.toUpperCase() ?? null
  if (pullRequestState === 'MERGED' && observation.mergeCommit) {
    return { state: 'merged', mergeCommit: observation.mergeCommit }
  }
  if (pullRequestState === 'MERGED') return { state: 'merged-without-commit' }
  if (pullRequestState === 'CLOSED') return { state: 'closed' }
  if (pullRequestState === 'OPEN' && entryState === 'UNMERGEABLE') return { state: 'failed' }
  if (pullRequestState === 'OPEN' && entryState && ACTIVE_ENTRY_STATES.has(entryState)) {
    return { state: 'queued' }
  }
  if (pullRequestState === 'OPEN' && entryState === null) {
    return {
      state: 'dequeued',
      reason: removalReason(observation, lastEnqueuedAt, enqueueSubmittedAt),
    }
  }
  return {
    state: 'unknown',
    detail: `pull request state ${observation.pullRequestState}, queue entry ${observation.entryState ?? 'none'}, merge commit ${observation.mergeCommit ?? 'none'}`,
  }
}

function confirmedDequeueReason(
  queue: MergeQueueState,
  state: MergeQueueWaitState,
  now: number,
): string | null {
  return queue.state === 'dequeued' &&
    state.dequeueObservedAt !== null &&
    now - state.dequeueObservedAt >= MERGE_QUEUE_DEQUEUE_CONFIRM_MS
    ? queue.reason
    : null
}

function removalClaimsMerged(reason: string): boolean {
  return reason.toLowerCase() === 'merged'
}

export function mergedWithoutCommitRefusal(
  number: number,
): Extract<MergeQueueAction, { action: 'refuse' }> {
  return {
    action: 'refuse',
    refusal: `GitHub reports pull request #${number} merged but has published no merge commit`,
    remedy: `once GitHub has published the merge commit, re-run ${PLATFORM_SLUG} pr merge ${number}`,
  }
}

function closedMergeQueueStep(
  number: number,
  state: MergeQueueWaitState,
  now: number,
  deadline: number,
  retry: string,
): MergeQueueStep {
  const closedObservedAt = state.closedObservedAt ?? now
  const observed = { ...state, closedObservedAt }
  if (now - closedObservedAt < MERGE_QUEUE_CLOSED_REPOLL_MS && now < deadline) {
    return {
      state: observed,
      action: {
        action: 'wait',
        delay: Math.min(
          MERGE_QUEUE_POLL_MS,
          deadline - now,
          MERGE_QUEUE_CLOSED_REPOLL_MS - (now - closedObservedAt),
        ),
      },
    }
  }
  return {
    state: observed,
    action: {
      action: 'refuse',
      refusal: `pull request #${number} was closed without merging`,
      remedy: `reopen or replace the pull request, then ${retry}`,
    },
  }
}

function mergedWithoutCommitStep(
  number: number,
  state: MergeQueueWaitState,
  now: number,
  deadline: number,
): MergeQueueStep {
  return {
    state,
    action:
      now < deadline
        ? { action: 'wait', delay: Math.min(MERGE_QUEUE_POLL_MS, deadline - now) }
        : mergedWithoutCommitRefusal(number),
  }
}

function dequeueRefusal(
  number: number,
  reason: string,
  landingBranch: string,
): Extract<MergeQueueAction, { action: 'refuse' }> {
  const retry = `${PLATFORM_SLUG} pr merge ${number}`
  if (reason.toLowerCase() === 'failed_checks') {
    return {
      action: 'refuse',
      refusal: `pull request #${number} failed in the merge queue (reason: ${reason})`,
      remedy: `push a fix if the check failure is real, or re-run ${retry} to requeue the unchanged head if it flaked`,
      source: 'failed-check',
    }
  }
  const reasonRefusesOnItsOwn = reason.toLowerCase() !== 'unknown' && !removalClaimsMerged(reason)
  return {
    action: 'refuse',
    refusal: `pull request #${number} was dequeued without a failed check (reason: ${reason})`,
    remedy:
      reason.toLowerCase() === 'merge_conflict'
        ? `merge origin/${landingBranch} into the pull-request branch, push it, then ${retry}`
        : retry,
    ...(reasonRefusesOnItsOwn ? { source: 'dequeue-reason' as const } : {}),
  }
}

export function stepMergeQueueWait(
  number: number,
  previous: MergeQueueWaitState,
  queue: MergeQueueState,
  now: number,
  deadline: number,
  landingBranch: string,
): MergeQueueStep {
  let state = observedMergeQueueState(previous, queue, now)

  const retry = `${PLATFORM_SLUG} pr merge ${number}`
  if (queue.state === 'merged') {
    return { state, action: { action: 'verify-landing', mergeCommit: queue.mergeCommit } }
  }
  if (queue.state === 'merged-without-commit') {
    return mergedWithoutCommitStep(number, state, now, deadline)
  }
  if (queue.state === 'closed') {
    return closedMergeQueueStep(number, state, now, deadline, retry)
  }
  if (queue.state === 'failed') {
    return failedMergeQueueStep(number, state, now, deadline)
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
    (state.activeEntryObserved || (state.enqueueSubmitted && queue.reason !== 'unknown')) &&
    queue.reason !== 'unknown' &&
    !removalClaimsMerged(queue.reason)
  ) {
    return { state, action: dequeueRefusal(number, queue.reason, landingBranch) }
  }
  if (queue.state === 'dequeued' && !state.enqueueSubmitted && !state.activeEntryObserved) {
    state = { ...state, enqueueSubmitted: true, enqueueSubmittedAt: now }
    return { state, action: { action: 'enqueue' } }
  }
  const confirmedReason = confirmedDequeueReason(queue, state, now)
  if (confirmedReason !== null && !removalClaimsMerged(confirmedReason)) {
    return { state, action: dequeueRefusal(number, confirmedReason, landingBranch) }
  }
  const dequeueConfirmationRemaining =
    queue.state === 'dequeued' &&
    !removalClaimsMerged(queue.reason) &&
    state.dequeueObservedAt !== null
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

/** Decide whether GitHub's comparison proves the merge commit is on the landing branch. */
export function mergeLandingComparisonProvesLanded(status: string): boolean {
  return status === 'identical' || status === 'behind'
}

export type MergeLandingComparison = { status: string } | { error: string }

/** Decide whether a merged pull request has been confirmed on its landing branch. */
export function stepMergeQueueLanding(
  number: number,
  mergeCommit: string,
  repositoryAvailable: boolean,
  comparison: MergeLandingComparison | null,
  now: number,
  deadline: number,
): MergeQueueAction {
  const retry = `${PLATFORM_SLUG} pr merge ${number}`
  if (!repositoryAvailable) {
    return {
      action: 'refuse',
      refusal: 'registered repository identity is unavailable',
      remedy: `restore the project remote, then ${retry}`,
    }
  }
  if (
    comparison &&
    'status' in comparison &&
    mergeLandingComparisonProvesLanded(comparison.status)
  ) {
    return { action: 'complete', mergeCommit }
  }
  if (now < deadline) {
    return { action: 'wait', delay: Math.min(MERGE_QUEUE_POLL_MS, deadline - now) }
  }
  const detail = comparison
    ? 'error' in comparison
      ? `last error: ${comparison.error}`
      : `last status: ${comparison.status}`
    : 'comparison was unavailable'
  return {
    action: 'refuse',
    refusal: `GitHub reports pull request #${number} merged as ${mergeCommit}, but the landing check could not be confirmed (${detail})`,
    remedy: `re-run ${retry}`,
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
