import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  decideMergeQueueAction,
  interpretMergeQueue,
  MERGE_QUEUE_DEQUEUE_CONFIRM_MS,
  mergeQueueEnqueueFailureRemedy,
} from './merge-queue-decision.ts'

describe('merge-queue state', () => {
  test('only a merged pull request carrying its commit reads as merged', () => {
    expect(
      interpretMergeQueue({
        pullRequestState: 'MERGED',
        mergeCommit: 'merge-oid',
        entryState: null,
      }),
    ).toEqual({ state: 'merged', mergeCommit: 'merge-oid' })
    expect(
      interpretMergeQueue({ pullRequestState: 'MERGED', mergeCommit: null, entryState: null }),
    ).toEqual({
      state: 'unknown',
      detail: 'pull request state MERGED, queue entry none, merge commit none',
    })
  })

  test.each(['AWAITING_CHECKS', 'LOCKED', 'MERGEABLE', 'QUEUED'])(
    'entry state %s remains queued',
    (entryState) => {
      expect(
        interpretMergeQueue({ pullRequestState: 'OPEN', mergeCommit: null, entryState }),
      ).toEqual({ state: 'queued' })
    },
  )

  test('an unmergeable entry is failed and an absent entry is dequeued', () => {
    expect(
      interpretMergeQueue({
        pullRequestState: 'OPEN',
        mergeCommit: null,
        entryState: 'UNMERGEABLE',
      }),
    ).toEqual({ state: 'failed' })
    expect(
      interpretMergeQueue({ pullRequestState: 'OPEN', mergeCommit: null, entryState: null }),
    ).toEqual({ state: 'dequeued' })
  })

  test('a closed pull request is distinct from an open pull request with no queue entry', () => {
    expect(
      interpretMergeQueue({ pullRequestState: 'CLOSED', mergeCommit: null, entryState: null }),
    ).toEqual({ state: 'closed' })
  })
})

describe('merge-queue action', () => {
  test('an already-queued pull request waits instead of enqueueing twice', () => {
    expect(decideMergeQueueAction(42, { state: 'queued' }, false, true, null, 0, 20_000)).toEqual({
      action: 'wait',
      delay: 10_000,
    })
  })

  test('an absent entry is enqueued once, then waited for until an entry is observed', () => {
    expect(
      decideMergeQueueAction(42, { state: 'dequeued' }, false, false, null, 0, 20_000),
    ).toEqual({
      action: 'enqueue',
    })
    expect(decideMergeQueueAction(42, { state: 'dequeued' }, true, false, null, 0, 20_000)).toEqual(
      {
        action: 'wait',
        delay: 10_000,
      },
    )
  })

  test('a transition gap waits and can still complete as merged', () => {
    const deadline = MERGE_QUEUE_DEQUEUE_CONFIRM_MS * 2
    expect(decideMergeQueueAction(42, { state: 'dequeued' }, true, true, 0, 1, deadline)).toEqual({
      action: 'wait',
      delay: 10_000,
    })
    expect(
      decideMergeQueueAction(
        42,
        { state: 'merged', mergeCommit: 'merge-oid' },
        true,
        true,
        0,
        MERGE_QUEUE_DEQUEUE_CONFIRM_MS - 1,
        deadline,
      ),
    ).toEqual({ action: 'complete', mergeCommit: 'merge-oid' })
  })

  test('an absent entry for the confirmation window refuses as having left the queue', () => {
    expect(
      decideMergeQueueAction(
        42,
        { state: 'dequeued' },
        true,
        true,
        0,
        MERGE_QUEUE_DEQUEUE_CONFIRM_MS,
        MERGE_QUEUE_DEQUEUE_CONFIRM_MS * 2,
      ),
    ).toEqual({
      action: 'refuse',
      refusal: expect.stringContaining('left the merge queue without merging'),
      remedy: expect.stringContaining('fix the dequeue reason'),
    })
  })

  test('a closed pull request refuses immediately after an active entry', () => {
    expect(decideMergeQueueAction(42, { state: 'closed' }, true, true, null, 0, 20_000)).toEqual({
      action: 'refuse',
      refusal: expect.stringContaining('left the merge queue without merging'),
      remedy: expect.stringContaining('fix the dequeue reason'),
    })
  })

  test('failed and unknown states never complete', () => {
    expect(decideMergeQueueAction(42, { state: 'failed' }, true, true, null, 0, 20_000)).toEqual({
      action: 'refuse',
      refusal: expect.stringContaining('failed in the merge queue'),
      remedy: expect.any(String),
    })
    expect(
      decideMergeQueueAction(
        42,
        { state: 'unknown', detail: 'new forge state' },
        true,
        true,
        null,
        0,
        20_000,
      ),
    ).toEqual({
      action: 'refuse',
      refusal: expect.stringContaining('unknown merge-queue state'),
      remedy: expect.any(String),
    })
  })

  test('the deadline refuses with the retry remedy', () => {
    expect(
      decideMergeQueueAction(42, { state: 'queued' }, true, true, null, 20_000, 20_000),
    ).toEqual({
      action: 'refuse',
      refusal: expect.stringContaining('did not merge within'),
      remedy: expect.stringContaining(`re-run ${PLATFORM_SLUG} pr merge 42`),
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
