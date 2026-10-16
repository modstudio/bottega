import { describe, expect, test } from 'bun:test'
import { decideMergeQueueAction, interpretMergeQueue } from './merge-queue-decision.ts'

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
})

describe('merge-queue action', () => {
  test('an already-queued pull request waits instead of enqueueing twice', () => {
    expect(decideMergeQueueAction(42, { state: 'queued' }, false)).toEqual({ action: 'wait' })
  })

  test('only a never-established absent entry is enqueued', () => {
    expect(decideMergeQueueAction(42, { state: 'dequeued' }, false)).toEqual({
      action: 'enqueue',
    })
    expect(decideMergeQueueAction(42, { state: 'dequeued' }, true)).toEqual({
      action: 'refuse',
      refusal: expect.stringContaining('left the merge queue without merging'),
    })
  })

  test('failed and unknown states never complete', () => {
    expect(decideMergeQueueAction(42, { state: 'failed' }, true)).toEqual({
      action: 'refuse',
      refusal: expect.stringContaining('failed in the merge queue'),
    })
    expect(
      decideMergeQueueAction(42, { state: 'unknown', detail: 'new forge state' }, true),
    ).toEqual({
      action: 'refuse',
      refusal: expect.stringContaining('unknown merge-queue state'),
    })
  })
})
