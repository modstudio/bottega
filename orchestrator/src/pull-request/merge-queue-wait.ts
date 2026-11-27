// concern: merge-queue wait adapter
/** Repeatedly gathers forge observations while pure merge-queue decisions own policy. */

import {
  interpretMergeQueue,
  MERGE_QUEUE_WAIT_MS,
  type MergeQueueObservation,
  type MergeQueueState,
  type MergeQueueStep,
  type MergeQueueWaitState,
  stepMergeQueueLanding,
  stepMergeQueueWait,
} from './merge-queue-decision.ts'

type QueuePullRequest = {
  nodeId: string
  number: number
  baseBranch: string
}

export type MergeQueueWaitAdapter = {
  queueState(cwd: string, nodeId: string): MergeQueueObservation
  landingComparison(
    cwd: string,
    repository: string,
    landingBranch: string,
    mergeCommit: string,
  ): string
  now(): number
  wait(milliseconds: number): void
}

type QueueWaitInput = Parameters<typeof driveMergeQueueWait>[0]

function performMergeQueueAction(
  input: QueueWaitInput,
  action: MergeQueueStep['action'],
  state: MergeQueueState,
  now: number,
  deadline: number,
  enqueuedAt: string | null,
  requeueOutput: string | undefined,
): { complete: string } | { requeueOutput: string | undefined } {
  if (action.action === 'verify-landing') {
    let comparison: { status: string } | { error: string } | null = null
    if (input.repository) {
      try {
        comparison = {
          status: input.adapter.landingComparison(
            input.cwd,
            input.repository,
            input.pullRequest.baseBranch,
            action.mergeCommit,
          ),
        }
      } catch (cause) {
        comparison = { error: cause instanceof Error ? cause.message : String(cause) }
      }
    }
    return performMergeQueueAction(
      input,
      stepMergeQueueLanding(
        input.pullRequest.number,
        action.mergeCommit,
        input.repository !== null,
        comparison,
        now,
        deadline,
      ),
      state,
      now,
      deadline,
      enqueuedAt,
      requeueOutput,
    )
  }
  if (action.action === 'complete') {
    return { complete: action.mergeCommit }
  }
  if (action.action === 'refuse') input.refuse(action, state, enqueuedAt)
  if (action.action === 'enqueue') input.enqueue()
  else if (action.action === 'requeue') requeueOutput = input.requeue(enqueuedAt)
  else input.adapter.wait(action.delay)
  return { requeueOutput }
}

export function driveMergeQueueWait(input: {
  pullRequest: QueuePullRequest
  cwd: string
  repository: string | null
  target: string
  adapter: MergeQueueWaitAdapter
  refuse(
    action: Extract<MergeQueueStep['action'], { action: 'refuse' }>,
    state: MergeQueueState,
    enqueuedAt: string | null,
  ): never
  enqueue(): void
  requeue(enqueuedAt: string | null): string
}): { mergeCommit: string; requeueOutput?: string } {
  const deadline = input.adapter.now() + MERGE_QUEUE_WAIT_MS
  let waitState: MergeQueueWaitState = {
    enqueueSubmitted: false,
    enqueueSubmittedAt: null,
    activeEntryObserved: false,
    dequeueObservedAt: null,
    requeuePendingSince: null,
    closedObservedAt: null,
  }
  let requeueOutput: string | undefined
  let lastEnqueuedAt: string | null = null
  while (true) {
    const observation = input.adapter.queueState(input.cwd, input.pullRequest.nodeId)
    if (observation.enqueuedAt) lastEnqueuedAt = observation.enqueuedAt
    const state = interpretMergeQueue(observation, lastEnqueuedAt, waitState.enqueueSubmittedAt)
    const now = input.adapter.now()
    const step = stepMergeQueueWait(
      input.pullRequest.number,
      waitState,
      state,
      now,
      deadline,
      input.pullRequest.baseBranch,
    )
    waitState = step.state
    const result = performMergeQueueAction(
      input,
      step.action,
      state,
      now,
      deadline,
      lastEnqueuedAt,
      requeueOutput,
    )
    if ('complete' in result) {
      return {
        mergeCommit: result.complete,
        ...(requeueOutput ? { requeueOutput } : {}),
      }
    }
    requeueOutput = result.requeueOutput
  }
}
