import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  interpretMergeQueue,
  MERGE_QUEUE_DEQUEUE_CONFIRM_MS,
  MERGE_QUEUE_REQUEUE_CONFIRM_MS,
  type MergeQueueWaitState,
  mergeQueueEnqueueFailureRemedy,
  stepMergeQueueWait,
} from './merge-queue-decision.ts'

const initialWaitState: MergeQueueWaitState = {
  enqueueSubmitted: false,
  activeEntryObserved: false,
  dequeueObservedAt: null,
  requeuePendingSince: null,
}

describe('merge-queue state', () => {
  test('only a merged pull request carrying its commit reads as merged', () => {
    expect(
      interpretMergeQueue({
        pullRequestState: 'MERGED',
        mergeCommit: 'merge-oid',
        entryState: null,
        enqueuedAt: null,
      }),
    ).toEqual({ state: 'merged', mergeCommit: 'merge-oid' })
    expect(
      interpretMergeQueue({
        pullRequestState: 'MERGED',
        mergeCommit: null,
        entryState: null,
        enqueuedAt: null,
      }),
    ).toEqual({
      state: 'unknown',
      detail: 'pull request state MERGED, queue entry none, merge commit none',
    })
  })

  test.each(['AWAITING_CHECKS', 'LOCKED', 'MERGEABLE', 'QUEUED'])(
    'entry state %s remains queued',
    (entryState) => {
      expect(
        interpretMergeQueue({
          pullRequestState: 'OPEN',
          mergeCommit: null,
          entryState,
          enqueuedAt: '2026-10-24T10:00:00Z',
        }),
      ).toEqual({ state: 'queued' })
    },
  )

  test('an unmergeable entry is failed and an absent entry is dequeued', () => {
    expect(
      interpretMergeQueue({
        pullRequestState: 'OPEN',
        mergeCommit: null,
        entryState: 'UNMERGEABLE',
        enqueuedAt: '2026-10-24T10:00:00Z',
      }),
    ).toEqual({ state: 'failed' })
    expect(
      interpretMergeQueue({
        pullRequestState: 'OPEN',
        mergeCommit: null,
        entryState: null,
        enqueuedAt: null,
      }),
    ).toEqual({ state: 'dequeued' })
  })

  test('a closed pull request is distinct from an open pull request with no queue entry', () => {
    expect(
      interpretMergeQueue({
        pullRequestState: 'CLOSED',
        mergeCommit: null,
        entryState: null,
        enqueuedAt: null,
      }),
    ).toEqual({ state: 'closed' })
  })
})

describe('merge-queue action', () => {
  test('an already-queued pull request waits instead of enqueueing twice', () => {
    expect(stepMergeQueueWait(42, initialWaitState, { state: 'queued' }, 0, 20_000)).toEqual({
      state: { ...initialWaitState, activeEntryObserved: true },
      action: { action: 'wait', delay: 10_000 },
    })
  })

  test('an absent entry is enqueued once, then waited for until an entry is observed', () => {
    const enqueue = stepMergeQueueWait(42, initialWaitState, { state: 'dequeued' }, 0, 20_000)
    expect(enqueue).toEqual({
      state: { ...initialWaitState, enqueueSubmitted: true },
      action: { action: 'enqueue' },
    })
    expect(stepMergeQueueWait(42, enqueue.state, { state: 'dequeued' }, 0, 20_000)).toEqual({
      state: enqueue.state,
      action: { action: 'wait', delay: 10_000 },
    })
  })

  test('a transition gap waits and can still complete as merged', () => {
    const deadline = MERGE_QUEUE_DEQUEUE_CONFIRM_MS * 2
    const queued = stepMergeQueueWait(42, initialWaitState, { state: 'queued' }, 0, deadline)
    const gap = stepMergeQueueWait(42, queued.state, { state: 'dequeued' }, 1, deadline)
    expect(gap).toEqual({
      state: { ...queued.state, dequeueObservedAt: 1 },
      action: { action: 'wait', delay: 10_000 },
    })
    expect(
      stepMergeQueueWait(
        42,
        gap.state,
        { state: 'merged', mergeCommit: 'merge-oid' },
        MERGE_QUEUE_DEQUEUE_CONFIRM_MS - 1,
        deadline,
      ),
    ).toEqual({ state: gap.state, action: { action: 'complete', mergeCommit: 'merge-oid' } })
  })

  test('an absent entry for the confirmation window refuses as having left the queue', () => {
    const observedAt = 1
    expect(
      stepMergeQueueWait(
        42,
        { ...initialWaitState, activeEntryObserved: true, dequeueObservedAt: observedAt },
        { state: 'dequeued' },
        observedAt + MERGE_QUEUE_DEQUEUE_CONFIRM_MS,
        MERGE_QUEUE_DEQUEUE_CONFIRM_MS * 2,
      ),
    ).toEqual({
      state: {
        ...initialWaitState,
        activeEntryObserved: true,
        dequeueObservedAt: observedAt,
      },
      action: {
        action: 'refuse',
        refusal: expect.stringContaining('left the merge queue without merging'),
        remedy: expect.stringContaining('fix the dequeue reason'),
      },
    })
  })

  test('a closed pull request refuses immediately after an active entry', () => {
    const state = { ...initialWaitState, enqueueSubmitted: true, activeEntryObserved: true }
    expect(stepMergeQueueWait(42, state, { state: 'closed' }, 0, 20_000)).toEqual({
      state,
      action: {
        action: 'refuse',
        refusal: expect.stringContaining('left the merge queue without merging'),
        remedy: expect.stringContaining('fix the dequeue reason'),
      },
    })
  })

  test('a renewed active entry clears dequeue confirmation', () => {
    const gapState = {
      ...initialWaitState,
      enqueueSubmitted: true,
      activeEntryObserved: true,
      dequeueObservedAt: 1,
    }
    expect(stepMergeQueueWait(42, gapState, { state: 'queued' }, 2, 20_000)).toEqual({
      state: { ...gapState, dequeueObservedAt: null },
      action: { action: 'wait', delay: 10_000 },
    })
  })

  test('a failed first observation requeues once', () => {
    expect(stepMergeQueueWait(42, initialWaitState, { state: 'failed' }, 0, 20_000)).toEqual({
      state: { ...initialWaitState, enqueueSubmitted: true, requeuePendingSince: 0 },
      action: { action: 'requeue' },
    })
  })

  test('a failed entry after a requeue refuses with both remedies', () => {
    const state = { ...initialWaitState, enqueueSubmitted: true, requeuePendingSince: 0 }
    expect(
      stepMergeQueueWait(
        42,
        state,
        { state: 'failed' },
        MERGE_QUEUE_REQUEUE_CONFIRM_MS,
        MERGE_QUEUE_REQUEUE_CONFIRM_MS * 2,
      ),
    ).toEqual({
      state,
      action: {
        action: 'refuse',
        refusal: expect.stringContaining('failed in the merge queue'),
        remedy: expect.stringMatching(/push a fix.*re-run .* pr merge 42.*flaked/),
      },
    })
  })

  test('a stale failed reading after requeue waits inside the confirmation window', () => {
    const state = { ...initialWaitState, enqueueSubmitted: true, requeuePendingSince: 1 }
    expect(
      stepMergeQueueWait(42, state, { state: 'failed' }, 2, MERGE_QUEUE_REQUEUE_CONFIRM_MS * 2),
    ).toEqual({ state, action: { action: 'wait', delay: 10_000 } })
  })

  test('a failed entry after an observed active entry refuses without requeuing', () => {
    const state = { ...initialWaitState, activeEntryObserved: true }
    expect(stepMergeQueueWait(42, state, { state: 'failed' }, 0, 20_000)).toEqual({
      state,
      action: {
        action: 'refuse',
        refusal: expect.stringContaining('failed in the merge queue'),
        remedy: expect.stringContaining(`re-run ${PLATFORM_SLUG} pr merge 42`),
      },
    })
  })

  test('unknown states never complete', () => {
    expect(
      stepMergeQueueWait(
        42,
        initialWaitState,
        { state: 'unknown', detail: 'new forge state' },
        0,
        20_000,
      ),
    ).toEqual({
      state: initialWaitState,
      action: {
        action: 'refuse',
        refusal: expect.stringContaining('unknown merge-queue state'),
        remedy: expect.any(String),
      },
    })
  })

  test('the deadline refuses with the retry remedy', () => {
    expect(stepMergeQueueWait(42, initialWaitState, { state: 'queued' }, 20_000, 20_000)).toEqual({
      state: { ...initialWaitState, activeEntryObserved: true },
      action: {
        action: 'refuse',
        refusal: expect.stringContaining('did not merge within'),
        remedy: expect.stringContaining(`re-run ${PLATFORM_SLUG} pr merge 42`),
      },
    })
  })
})

describe('merge-queue enqueue failure remedy', () => {
  test('an auto-merge refusal names the repository setting', () => {
    expect(
      mergeQueueEnqueueFailureRemedy(
        42,
        'Auto merge is not allowed for this repository (enablePullRequestAutoMerge)',
      ),
    ).toBe(
      `enable auto-merge on the repository (allow_auto_merge), then ${PLATFORM_SLUG} pr merge 42`,
    )
  })

  test('another forge failure receives the generic forge-condition remedy', () => {
    expect(mergeQueueEnqueueFailureRemedy(42, 'merge queue is temporarily unavailable')).toBe(
      `fix the reported forge condition, then ${PLATFORM_SLUG} pr merge 42`,
    )
  })
})
