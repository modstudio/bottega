import { describe, expect, test } from 'bun:test'
import { decideSharedGitConfigChanges } from './shared-git-config.ts'

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
        key: 'core.hookspath',
        oldValues: ['/projects/app/.githooks'],
        newValues: [`${tree}/.githooks`],
      },
      {
        kind: 'repair',
        key: 'core.worktree',
        oldValues: [],
        newValues: [tree],
      },
    ])
  })

  test('reports a foreign change and a path outside the run tree', () => {
    expect(
      decideSharedGitConfigChanges(
        {},
        { 'user.name': ['Test'], 'core.hookspath': ['/projects/app/.githooks'] },
        tree,
      ),
    ).toEqual([
      { kind: 'report', key: 'user.name', oldValues: [], newValues: ['Test'] },
      {
        kind: 'report',
        key: 'core.hookspath',
        oldValues: [],
        newValues: ['/projects/app/.githooks'],
      },
    ])
  })

  test('returns no action when the config did not change', () => {
    expect(
      decideSharedGitConfigChanges({ 'user.name': ['Ada'] }, { 'user.name': ['Ada'] }, tree),
    ).toEqual([])
  })
})
