import { expect, test } from 'bun:test'
import { readRunDiffSource } from './run-diff.ts'

test('live diff checks existence and reads the tree while its lease is held', () => {
  // Production break watched fail: replace readLive(...) with readEvidence().
  const events: string[] = []
  const result = readRunDiffSource({
    repoRoot: '/repo',
    worktree: '/repo/tree',
    exists: () => {
      events.push('exists')
      return true
    },
    withWorktreeLease: (_repoRoot, _worktreePath, action) => {
      events.push('lease:start')
      const value = action()
      events.push('lease:end')
      return value
    },
    readLive: () => {
      events.push('live')
      return 'live changes'
    },
    readEvidence: () => {
      events.push('evidence')
      return 'branch changes'
    },
  })

  expect(result).toBe('live changes')
  expect(events).toEqual(['lease:start', 'exists', 'live', 'lease:end'])
})

test('an absent tree selects the evidence branch read after releasing its lease', () => {
  // Production break watched fail: replace exists(...) with true.
  const events: string[] = []
  const result = readRunDiffSource({
    repoRoot: '/repo',
    worktree: '/repo/tree',
    exists: () => {
      events.push('exists')
      return false
    },
    withWorktreeLease: (_repoRoot, _worktreePath, action) => {
      events.push('lease:start')
      const value = action()
      events.push('lease:end')
      return value
    },
    readLive: () => {
      events.push('live')
      return 'live changes'
    },
    readEvidence: () => {
      events.push('evidence')
      return 'branch changes'
    },
  })

  expect(result).toBe('branch changes')
  expect(events).toEqual(['lease:start', 'exists', 'lease:end', 'evidence'])
})
