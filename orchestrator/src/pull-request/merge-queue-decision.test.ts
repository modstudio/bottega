import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  stepMergeQueueWait as decideMergeQueueWait,
  interpretMergeQueue,
  MERGE_QUEUE_DEQUEUE_CONFIRM_MS,
  MERGE_QUEUE_REQUEUE_CONFIRM_MS,
  type MergeQueueState,
  type MergeQueueWaitState,
  mergeQueueEnqueueFailureRemedy,
} from './merge-queue-decision.ts'

const stepMergeQueueWait = (
  number: number,
  previous: MergeQueueWaitState,
  queue: MergeQueueState,
  now: number,
  deadline: number,
  landingBranch = 'main',
) => decideMergeQueueWait(number, previous, queue, now, deadline, landingBranch)

const initialWaitState: MergeQueueWaitState = {
  enqueueSubmitted: false,
  enqueueSubmittedAt: null,
  activeEntryObserved: false,
  dequeueObservedAt: null,
  requeuePendingSince: null,
  closedObservedAt: null,
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
    ).toEqual({ state: 'dequeued', reason: 'unknown' })
  })

  test('a removal reason older than the later enqueue fact is stale', () => {
    const observation = {
      pullRequestState: 'OPEN',
      mergeCommit: null,
      entryState: null,
      enqueuedAt: null,
      removalReason: 'merge_conflict',
      removedAt: '2026-10-24T10:00:00Z',
    }
    expect(interpretMergeQueue(observation, '2026-10-24T10:00:01Z')).toEqual({
      state: 'dequeued',
      reason: 'unknown',
    })
    expect(interpretMergeQueue(observation, null, Date.parse('2026-10-24T10:00:01Z'))).toEqual({
      state: 'dequeued',
      reason: 'unknown',
    })
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
    const enqueue = stepMergeQueueWait(
      42,
      initialWaitState,
      { state: 'dequeued', reason: 'unknown' },
      0,
      20_000,
    )
    expect(enqueue).toEqual({
      state: { ...initialWaitState, enqueueSubmitted: true, enqueueSubmittedAt: 0 },
      action: { action: 'enqueue' },
    })
    expect(
      stepMergeQueueWait(42, enqueue.state, { state: 'dequeued', reason: 'unknown' }, 0, 20_000),
    ).toEqual({
      state: enqueue.state,
      action: { action: 'wait', delay: 10_000 },
    })
  })

  test('an unknown vanished entry waits for confirmation before reporting its reason', () => {
    const deadline = 120_000
    const queued = stepMergeQueueWait(42, initialWaitState, { state: 'queued' }, 0, deadline)
    const gap = stepMergeQueueWait(
      42,
      queued.state,
      { state: 'dequeued', reason: 'unknown' },
      1,
      deadline,
    )
    expect(gap).toEqual({
      state: { ...queued.state, dequeueObservedAt: 1 },
      action: { action: 'wait', delay: 10_000 },
    })
    expect(
      stepMergeQueueWait(
        42,
        gap.state,
        { state: 'dequeued', reason: 'unknown' },
        1 + MERGE_QUEUE_DEQUEUE_CONFIRM_MS,
        120_000,
      ),
    ).toEqual({
      state: gap.state,
      action: {
        action: 'refuse',
        refusal: expect.stringContaining('dequeued without a failed check (reason: unknown)'),
        remedy: `${PLATFORM_SLUG} pr merge 42`,
      },
    })
  })

  test('a merged removal completes if the pull request catches up inside confirmation', () => {
    const queued = stepMergeQueueWait(42, initialWaitState, { state: 'queued' }, 0, 120_000)
    const gap = stepMergeQueueWait(
      42,
      queued.state,
      { state: 'dequeued', reason: 'merged' },
      1,
      120_000,
    )
    expect(gap.action).toEqual({ action: 'wait', delay: 10_000 })
    expect(
      stepMergeQueueWait(42, gap.state, { state: 'merged', mergeCommit: 'merge-oid' }, 2, 120_000)
        .action,
    ).toEqual({ action: 'verify-landing', mergeCommit: 'merge-oid' })
  })

  test('a merged removal past confirmation keeps waiting', () => {
    const state = {
      ...initialWaitState,
      activeEntryObserved: true,
      dequeueObservedAt: 1,
    }
    expect(
      stepMergeQueueWait(
        42,
        state,
        { state: 'dequeued', reason: 'merged' },
        1 + MERGE_QUEUE_DEQUEUE_CONFIRM_MS,
        120_000,
      ).action,
    ).toEqual({ action: 'wait', delay: 10_000 })
  })

  test('a merge-conflict dequeue reports the reason and names the clearing sequence', () => {
    const state = { ...initialWaitState, activeEntryObserved: true }
    expect(
      stepMergeQueueWait(
        42,
        state,
        { state: 'dequeued', reason: 'merge_conflict' },
        1,
        20_000,
        'trunk',
      ),
    ).toEqual({
      state: { ...state, dequeueObservedAt: 1 },
      action: {
        action: 'refuse',
        refusal: expect.stringContaining('reason: merge_conflict'),
        remedy:
          `merge origin/trunk into the pull-request branch, push it, then ` +
          `${PLATFORM_SLUG} pr merge 42`,
        source: 'dequeue-reason',
      },
    })
  })

  test('a removal event stops waiting even when the active entry was not polled', () => {
    const state = { ...initialWaitState, enqueueSubmitted: true }
    expect(
      stepMergeQueueWait(42, state, { state: 'dequeued', reason: 'merge_conflict' }, 1, 20_000)
        .action,
    ).toEqual({
      action: 'refuse',
      refusal: expect.stringContaining('reason: merge_conflict'),
      remedy: expect.stringContaining('merge origin/main'),
      source: 'dequeue-reason',
    })
  })

  test('a failed-checks dequeue reports a check failure and its fix-or-requeue remedy', () => {
    const state = { ...initialWaitState, activeEntryObserved: true }
    expect(
      stepMergeQueueWait(42, state, { state: 'dequeued', reason: 'FaIlEd_ChEcKs' }, 1, 20_000)
        .action,
    ).toEqual({
      action: 'refuse',
      refusal: expect.stringContaining('failed in the merge queue (reason: FaIlEd_ChEcKs)'),
      remedy: expect.stringMatching(/push a fix.*re-run .* pr merge 42.*flaked/),
      source: 'failed-check',
    })
  })

  test('a closed pull request refuses after its bounded re-poll', () => {
    const state = { ...initialWaitState, enqueueSubmitted: true, activeEntryObserved: true }
    const first = stepMergeQueueWait(42, state, { state: 'closed' }, 0, 60_000)
    expect(first.action).toEqual({ action: 'wait', delay: 10_000 })
    expect(stepMergeQueueWait(42, first.state, { state: 'closed' }, 30_000, 60_000)).toEqual({
      state: first.state,
      action: {
        action: 'refuse',
        refusal: expect.stringContaining('closed without merging'),
        remedy: expect.stringContaining('reopen or replace'),
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
        source: 'failed-check',
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
        source: 'failed-check',
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
