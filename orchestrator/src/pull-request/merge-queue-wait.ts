// concern: merge-queue wait adapter
/** Repeatedly gathers forge observations while pure merge-queue decisions own policy. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  interpretMergeQueue,
  MERGE_QUEUE_WAIT_MS,
  mergeLandingComparisonProvesLanded,
  type MergeQueueObservation,
  type MergeQueueState,
  type MergeQueueStep,
  type MergeQueueWaitState,
  stepMergeQueueWait,
} from './merge-queue-decision.ts'

type QueuePullRequest = {
  nodeId: string
  number: number
  baseBranch: string
}

export type MergeQueueWaitAdapter = {
  queueState(cwd: string, nodeId: string): MergeQueueObservation
  landingComparison(cwd: string, repository: string, landingBranch: string, mergeCommit: string): string
  now(): number
  wait(milliseconds: number): void
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
    const state = interpretMergeQueue(
      observation,
      lastEnqueuedAt,
      waitState.enqueueSubmittedAt,
    )
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
    const action = step.action
    if (action.action === 'verify-landing') {
      if (!input.repository) {
        throw new Error(
          `refusing merge: registered repository identity is unavailable; restore the project remote, then ${PLATFORM_SLUG} pr merge ${input.target}`,
        )
      }
      const comparison = input.adapter.landingComparison(
        input.cwd,
        input.repository,
        input.pullRequest.baseBranch,
        action.mergeCommit,
      )
      if (!mergeLandingComparisonProvesLanded(comparison)) {
        if (now >= deadline) {
          throw new Error(
            `refusing merge: GitHub reports pull request #${input.pullRequest.number} merged as ${action.mergeCommit}, but the landing branch does not yet contain it; re-run ${PLATFORM_SLUG} pr merge ${input.target}`,
          )
        }
        input.adapter.wait(Math.min(10_000, deadline - now))
        continue
      }
      return {
        mergeCommit: action.mergeCommit,
        ...(requeueOutput ? { requeueOutput } : {}),
      }
    }
    if (action.action === 'refuse') input.refuse(action, state, lastEnqueuedAt)
    if (action.action === 'enqueue') {
      input.enqueue()
      continue
    }
    if (action.action === 'requeue') {
      requeueOutput = input.requeue(lastEnqueuedAt)
      continue
    }
    input.adapter.wait(action.delay)
  }
}
