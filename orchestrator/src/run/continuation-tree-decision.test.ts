import { describe, expect, test } from 'bun:test'
import { continuationTreeDecision, retryLaunchDecision } from './continuation-tree-decision.ts'

describe('continuation tree decision', () => {
  test.each([
    [
      'inherits a present reader tree',
      {
        readsRepo: true,
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
        readsRepo: true,
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
        readsRepo: true,
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
        readsRepo: true,
        writesRepo: false,
        recordedTreePresent: false,
        writerTreeRecoverable: false,
        baseCommit: 'abc123',
        baseCommitAvailable: false,
      },
      { action: 'refuse', reason: 'reader-base-unavailable' },
    ],
    [
      'repository-free job needs no tree or reader base',
      {
        readsRepo: false,
        writesRepo: false,
        recordedTreePresent: false,
        writerTreeRecoverable: false,
        baseCommit: null,
        baseCommitAvailable: false,
      },
      { action: 'no-tree-required' },
    ],
  ] as const)('%s', (_name, input, expected) => {
    expect(continuationTreeDecision(input)).toEqual(expected)
  })
})

describe('retry launch decision', () => {
  test('a reading retry launches from the original caller without an explicit base', () => {
    expect(
      retryLaunchDecision({
        writesRepo: false,
        inheritedCwd: '/runs/failed-reader-clone',
        originalLaunchCwd: '/projects/caller',
        base: 'reader-base',
        launchBase: 'explicit-reader-base',
      }),
    ).toEqual({ cwd: '/projects/caller', base: undefined, launchBase: undefined })
  })

  test('a reading retry falls back to the recorded continuation checkout', () => {
    expect(
      retryLaunchDecision({
        writesRepo: false,
        inheritedCwd: '/projects/fallback',
        originalLaunchCwd: null,
        base: 'reader-base',
        launchBase: 'explicit-reader-base',
      }),
    ).toEqual({ cwd: '/projects/fallback', base: undefined, launchBase: undefined })
  })

  test('a writing retry inherits its tree and explicit base', () => {
    expect(
      retryLaunchDecision({
        writesRepo: true,
        inheritedCwd: '/runs/writer-tree',
        originalLaunchCwd: '/projects/caller',
        base: 'writer-base',
        launchBase: 'explicit-writer-base',
      }),
    ).toEqual({
      cwd: '/runs/writer-tree',
      base: 'writer-base',
      launchBase: 'explicit-writer-base',
    })
  })
})
