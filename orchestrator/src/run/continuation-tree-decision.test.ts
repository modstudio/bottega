import { describe, expect, test } from 'bun:test'
import { continuationTreeDecision } from './continuation-tree-decision.ts'

describe('continuation tree decision', () => {
  test.each([
    [
      'inherits a present reader tree',
      {
        writesRepo: false,
        recordedTreePresent: true,
        writerTreeRecoverable: false,
        baseCommit: 'abc123',
        baseCommitAvailable: true,
      },
      { action: 'inherit-present-tree' },
    ],
    [
      'recreates a released writer tree',
      {
        writesRepo: true,
        recordedTreePresent: false,
        writerTreeRecoverable: true,
        baseCommit: 'abc123',
        baseCommitAvailable: true,
      },
      { action: 'recreate-writer-tree' },
    ],
    [
      'provisions a released reader tree at its base commit',
      {
        writesRepo: false,
        recordedTreePresent: false,
        writerTreeRecoverable: false,
        baseCommit: 'abc123',
        baseCommitAvailable: true,
      },
      { action: 'provision-reader-tree', baseCommit: 'abc123' },
    ],
    [
      'refuses a reader whose base commit is gone',
      {
        writesRepo: false,
        recordedTreePresent: false,
        writerTreeRecoverable: false,
        baseCommit: 'abc123',
        baseCommitAvailable: false,
      },
      { action: 'refuse', reason: 'reader-base-unavailable' },
    ],
  ] as const)('%s', (_name, input, expected) => {
    expect(continuationTreeDecision(input)).toEqual(expected)
  })
})
