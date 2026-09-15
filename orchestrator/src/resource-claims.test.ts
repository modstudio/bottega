import { describe, expect, test } from 'bun:test'
import {
  claimCreationDecision,
  claimKindForCreation,
  createdWorktreeClaimKinds,
  sandboxDirectoryRelease,
  settledStateForCloseOut,
  settledStateForDatabaseTeardown,
  settledStateForWorktreeResource,
} from './resource-claims.ts'

describe('resource claim decisions', () => {
  const releasableSandbox = {
    terminal: true,
    liveTurn: false,
    liveProcess: false,
    worktreeState: 'released' as const,
    keepTree: false,
    directoryExists: true,
  }

  test('sandbox release keeps every live or explicitly held conversation resource', () => {
    expect(sandboxDirectoryRelease({ ...releasableSandbox, terminal: false })).toBe(
      'keep:conversation is not terminal',
    )
    expect(sandboxDirectoryRelease({ ...releasableSandbox, liveTurn: true })).toBe(
      'keep:conversation has a live turn',
    )
    expect(sandboxDirectoryRelease({ ...releasableSandbox, liveProcess: true })).toBe(
      'keep:conversation has a live process',
    )
    expect(sandboxDirectoryRelease({ ...releasableSandbox, keepTree: true })).toBe(
      'keep:held by explicit --keep-tree',
    )
    expect(sandboxDirectoryRelease({ ...releasableSandbox, worktreeState: 'claimed' })).toBe(
      'keep:worktree is still held',
    )
  })

  test('sandbox release accepts a released tree or no tree and reports an absent directory', () => {
    expect(sandboxDirectoryRelease(releasableSandbox)).toBe('release')
    expect(sandboxDirectoryRelease({ ...releasableSandbox, worktreeState: 'no-tree' })).toBe(
      'release',
    )
    expect(sandboxDirectoryRelease({ ...releasableSandbox, directoryExists: false })).toBe('absent')
  })

  test('creation records exactly the resources that were created', () => {
    expect(claimKindForCreation('sandbox_directory')).toBe('sandbox_dir')
    expect(claimKindForCreation('trust_heading')).toBe('trust_entry')
    expect(claimKindForCreation('serve_port')).toBe('port')
    expect(claimKindForCreation('database')).toBe('database')
  })

  test('a sandbox directory is recorded once per conversation root', () => {
    expect(claimCreationDecision(null, 41)).toBe('record')
    expect(claimCreationDecision(41, 41)).toBe('duplicate')
  })

  test('a port held by another conversation is a collision', () => {
    expect(claimCreationDecision(41, 42)).toBe('collision')
    expect(claimCreationDecision(42, 42)).toBe('duplicate')
  })

  test('database and worktree-owned port settlement preserve their lifecycle distinction', () => {
    expect(settledStateForDatabaseTeardown(true)).toBe('released')
    expect(settledStateForDatabaseTeardown(false)).toBe('retained')
    expect(settledStateForWorktreeResource('released', 'port')).toBe('released')
    expect(settledStateForWorktreeResource('forgotten', 'port')).toBe('released')
    expect(settledStateForWorktreeResource('absent', 'port')).toBe('released')
    expect(settledStateForWorktreeResource('released', 'database')).toBeNull()
  })

  test('only orch-owned creation records worktree and minted branch claims', () => {
    expect(createdWorktreeClaimKinds({ owned: false, mintedBranch: 'DEV-1' })).toEqual([])
    expect(createdWorktreeClaimKinds({ owned: true, mintedBranch: null })).toEqual(['worktree'])
    expect(createdWorktreeClaimKinds({ owned: true, mintedBranch: 'DEV-1' })).toEqual([
      'worktree',
      'branch',
    ])
  })

  test('close-out settles only the states established by its outcome', () => {
    expect(settledStateForCloseOut('released', 'worktree')).toBe('released')
    expect(settledStateForCloseOut('forgotten', 'worktree')).toBe('forgotten')
    expect(settledStateForCloseOut('absent', 'worktree')).toBe('absent')
    expect(settledStateForCloseOut('released', 'branch')).toBe('retained')
    for (const outcome of ['held', 'live', 'failed'] as const) {
      expect(settledStateForCloseOut(outcome, 'worktree')).toBeNull()
    }
    expect(settledStateForCloseOut('released', 'retained_ref')).toBeNull()
  })
})
