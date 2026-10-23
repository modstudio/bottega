import { describe, expect, test } from 'bun:test'
import {
  decideSharedGitConfigChanges,
  parseConfigList,
  shouldSnapshotSharedGitConfig,
} from './shared-git-config.ts'

describe('writing-run shared git config decision', () => {
  const tree = '/projects/app/.claude/worktrees/run-1'

  test('restores a changed run-tree path and removes a newly added run-tree path', () => {
    expect(
      decideSharedGitConfigChanges(
        { 'core.hookspath': ['/projects/app/.githooks'] },
        {
          'core.hookspath': [`${tree}/.githooks`],
          'core.worktree': [tree],
        },
        tree,
      ),
    ).toEqual([
      {
        kind: 'repair',
        change: 'changed',
        key: 'core.hookspath',
        namesRunTree: true,
        oldValues: ['/projects/app/.githooks'],
        newValues: [`${tree}/.githooks`],
      },
      {
        kind: 'repair',
        change: 'added',
        key: 'core.worktree',
        namesRunTree: true,
        oldValues: [],
        newValues: [tree],
      },
    ])
  })

  test('reports a foreign change and a path outside the run tree', () => {
    expect(
      decideSharedGitConfigChanges(
        { 'user.name': ['Ada'], 'core.hookspath': ['/projects/old/.githooks'] },
        { 'user.name': ['Test'], 'core.hookspath': ['/projects/app/.githooks'] },
        tree,
      ),
    ).toEqual([
      {
        kind: 'report',
        change: 'changed',
        key: 'user.name',
        namesRunTree: false,
        oldValues: ['Ada'],
        newValues: ['Test'],
      },
      {
        kind: 'report',
        change: 'changed',
        key: 'core.hookspath',
        namesRunTree: false,
        oldValues: ['/projects/old/.githooks'],
        newValues: ['/projects/app/.githooks'],
      },
    ])
  })

  test('returns no action when the config did not change', () => {
    expect(
      decideSharedGitConfigChanges({ 'user.name': ['Ada'] }, { 'user.name': ['Ada'] }, tree),
    ).toEqual([])
  })

  test('parses valued, valueless, and repeated config entries', () => {
    expect(
      parseConfigList(
        'user.name\nAda\0merge.ff\0remote.origin.fetch\nfirst\0remote.origin.fetch\nsecond\0',
      ),
    ).toEqual({
      'user.name': ['Ada'],
      'merge.ff': [''],
      'remote.origin.fetch': ['first', 'second'],
    })
  })

  test('snapshots only writing jobs with a worktree', () => {
    expect(shouldSnapshotSharedGitConfig(true, tree)).toBe(true)
    expect(shouldSnapshotSharedGitConfig(false, tree)).toBe(false)
    expect(shouldSnapshotSharedGitConfig(true, null)).toBe(false)
  })
})
