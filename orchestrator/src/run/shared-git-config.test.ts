import { describe, expect, test } from 'bun:test'
import { readEventLog, runEventsPath } from '../events.ts'
import {
  decideSharedGitConfigChanges,
  parseConfigList,
  recordSharedGitConfigSnapshotFailure,
  sharedGitConfigRepairRefusal,
  sharedGitConfigRepairValues,
  sharedGitConfigRepairVerification,
  sharedGitConfigSnapshotPath,
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
        'user.name\nAda\0merge.ff\0alias.blank\n\0remote.origin.fetch\nfirst\0remote.origin.fetch\nsecond\0',
      ),
    ).toEqual({
      'user.name': ['Ada'],
      'merge.ff': [null],
      'alias.blank': [''],
      'remote.origin.fetch': ['first', 'second'],
    })
  })

  test('detects a change between valueless and explicitly empty entries', () => {
    expect(
      decideSharedGitConfigChanges({ 'merge.ff': [null] }, { 'merge.ff': [''] }, tree),
    ).toEqual([
      {
        kind: 'report',
        change: 'changed',
        key: 'merge.ff',
        namesRunTree: false,
        oldValues: [null],
        newValues: [''],
      },
    ])
  })

  test('refuses a repair that would have to recreate a valueless entry', () => {
    expect(
      sharedGitConfigRepairRefusal(
        {
          kind: 'repair',
          change: 'changed',
          key: 'core.hookspath',
          namesRunTree: true,
          oldValues: [null],
          newValues: [`${tree}/.githooks`],
        },
        tree,
      ),
    ).toBe('cannot restore a valueless config entry')
  })

  test('snapshots only writing jobs with a worktree', () => {
    expect(shouldSnapshotSharedGitConfig(true, tree)).toBe(true)
    expect(shouldSnapshotSharedGitConfig(false, tree)).toBe(false)
    expect(shouldSnapshotSharedGitConfig(true, null)).toBe(false)
  })

  test('keeps the snapshot beside the run directory rather than in worker scratch', () => {
    expect(sharedGitConfigSnapshotPath('run-1', '/runs')).toBe(
      '/runs/run-1/shared-git-config-snapshot.json',
    )
  })

  test('does not restore a baseline value that names the run tree', () => {
    const action = {
      kind: 'repair' as const,
      change: 'changed' as const,
      key: 'core.hookspath',
      namesRunTree: true,
      oldValues: [`${tree}/baseline-hooks`, '/projects/app/.githooks'],
      newValues: [`${tree}/worker-hooks`],
    }

    expect(sharedGitConfigRepairValues(action, tree)).toEqual({
      restore: ['/projects/app/.githooks'],
      removed: [`${tree}/worker-hooks`],
    })
  })

  test('verifies only removed and restored values while allowing a concurrent value', () => {
    const action = {
      kind: 'repair' as const,
      change: 'changed' as const,
      key: 'core.hookspath',
      namesRunTree: true,
      oldValues: ['/projects/app/.githooks'],
      newValues: [`${tree}/worker-hooks`],
    }

    expect(
      sharedGitConfigRepairVerification(action, tree, [
        '/projects/concurrent/.githooks',
        '/projects/app/.githooks',
      ]),
    ).toBeNull()
    expect(sharedGitConfigRepairVerification(action, tree, [`${tree}/worker-hooks`])).toContain(
      'removed run-tree',
    )
    expect(sharedGitConfigRepairVerification(action, tree, [])).toContain('restored config value')
  })

  test('records a failed snapshot persist and the missing-check consequence', () => {
    const runId = 'failed-snapshot-persist'
    recordSharedGitConfigSnapshotFailure(runId, {
      ok: false,
      configPath: '/repo/.git/config',
      error: 'could not persist shared git config snapshot: permission denied',
    })

    expect(readEventLog(runEventsPath(runId))).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        text: 'shared git config snapshot persist failed: permission denied; no shared-config check for this run',
      }),
    )
  })

  test('records a failed snapshot capture separately from a persist failure', () => {
    const runId = 'failed-snapshot-capture'
    recordSharedGitConfigSnapshotFailure(runId, {
      ok: false,
      configPath: null,
      error: 'could not resolve git common dir for /repo/tree',
    })

    expect(readEventLog(runEventsPath(runId))).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        text: 'shared git config snapshot capture failed: could not resolve git common dir for /repo/tree; no shared-config check for this run',
      }),
    )
  })
})
