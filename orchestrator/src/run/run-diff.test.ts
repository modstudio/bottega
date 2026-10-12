import { expect, test } from 'bun:test'
import {
  chooseSinceReadBound,
  readRunDiffSource,
  unchangedSinceReadMessage,
  validateRunDiffBounds,
} from './run-diff.ts'

test('since-read and since-base refuse because they choose different lower bounds', () => {
  expect(() =>
    validateRunDiffBounds({ has: (name) => name === 'since-read' || name === 'since-base' }),
  ).toThrow('choose different lower bounds')
})

test('since-read refuses a missing read with both remedies', () => {
  const decision = chooseSinceReadBound({
    runId: 1257,
    branch: 'DEV-1257-work',
    read: null,
    comparisonTip: 'current-tip',
    readIsAncestor: false,
  })

  expect(decision).toEqual({
    kind: 'refusal',
    message:
      'no architect read is recorded for branch DEV-1257-work\n' +
      'cleared by: record one with orch review read --note <note>, or run orch diff 1257 for the whole change',
  })
})

test('since-read refuses a rewritten branch and names both commits', () => {
  const decision = chooseSinceReadBound({
    runId: 1257,
    branch: 'DEV-1257-work',
    read: {
      tip: 'read-tip',
      recordedAt: '2026-10-12T12:00:00.000Z',
      note: 'read before fixes',
    },
    comparisonTip: 'rewritten-tip',
    readIsAncestor: false,
  })

  expect(decision.kind).toBe('refusal')
  if (decision.kind === 'refusal') {
    expect(decision.message).toContain('read-tip')
    expect(decision.message).toContain('rewritten-tip')
    expect(decision.message).toContain('cleared by: run orch diff 1257')
  }
})

test('since-read selects the recorded tip as the lower bound', () => {
  const read = {
    tip: 'read-tip',
    recordedAt: '2026-10-12T12:00:00.000Z',
    note: 'read before fixes',
  }
  expect(
    chooseSinceReadBound({
      runId: 1257,
      branch: 'DEV-1257-work',
      read,
      comparisonTip: 'later-tip',
      readIsAncestor: true,
    }),
  ).toEqual({ kind: 'bound', read })
})

test('an unchanged clean comparison names the architect read', () => {
  const read = {
    tip: 'read-tip',
    recordedAt: '2026-10-12T12:00:00.000Z',
    note: 'read before fixes',
  }
  expect(unchangedSinceReadMessage(read, 'read-tip', '')).toBe(
    'nothing changed since architect read read-tip recorded 2026-10-12T12:00:00.000Z',
  )
  expect(unchangedSinceReadMessage(read, 'later-tip', '')).toBeNull()
  expect(unchangedSinceReadMessage(read, 'read-tip', 'patch')).toBeNull()
})

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
