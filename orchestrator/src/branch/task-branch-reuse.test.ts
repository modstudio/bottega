import { describe, expect, test } from 'bun:test'
import {
  decideTaskBranchReuse,
  decideTaskBranchSessionReuse,
  type TaskBranchReuseFacts,
  taskBranchDivergenceRefusal,
  taskBranchForDispatchingSession,
  taskBranchSessionRefusal,
} from './task-branch-reuse.ts'

const candidate = {
  branch: 'DEV-1225-orch-7000',
  tip: 'abc123',
  commitCount: 2,
  mergeBase: 'def456',
  projectId: 1,
  projectName: 'project',
  nominatingRuns: [
    { id: 7000, sessionId: 'session-a' },
    { id: 7001, sessionId: 'session-a' },
  ],
  trunk: 'main',
  worktree: null,
}

describe('task branch nominating session ownership', () => {
  test('a candidate nominated by the dispatching session may be reused', () => {
    expect(decideTaskBranchSessionReuse('session-a', ['session-a'])).toEqual({ action: 'reuse' })
  })

  test('a candidate nominated only by another session is refused', () => {
    expect(decideTaskBranchSessionReuse('session-b', ['session-a'])).toEqual({ action: 'refuse' })
  })

  test('a candidate with any nominator from the dispatching session may be reused', () => {
    expect(decideTaskBranchSessionReuse('session-b', ['session-a', 'session-b'])).toEqual({
      action: 'reuse',
    })
  })

  test('a dispatch with no session identity cannot reuse a candidate', () => {
    expect(decideTaskBranchSessionReuse(null, [null])).toEqual({ action: 'refuse' })
  })

  test('the refusal names branch, tip, runs, sessions, and both explicit-base remedies', () => {
    const message = taskBranchSessionRefusal(candidate)
    expect(message).toContain('DEV-1225-orch-7000 tip abc123')
    expect(message).toContain('runs 7000, 7001: session-a')
    expect(message).toContain('--base main')
    expect(message).toContain('--base DEV-1225-orch-7000')
  })

  test('session enforcement throws the refusal for a candidate nominated only by another session', () => {
    expect(() => taskBranchForDispatchingSession(candidate, 'session-b')).toThrow(
      'refusing task branch DEV-1225-orch-7000 tip abc123',
    )
  })

  test('session enforcement passes through a candidate nominated by the dispatching session', () => {
    expect(taskBranchForDispatchingSession(candidate, 'session-a')).toBe(candidate)
  })
})

const facts = (overrides: Partial<TaskBranchReuseFacts> = {}): TaskBranchReuseFacts => ({
  callerOnTrunk: false,
  candidateIsAncestorOfCaller: false,
  callerIsAncestorOfCandidate: false,
  callerBranch: 'feature/DEV-969',
  callerHead: 'caller123',
  candidateBranch: 'DEV-969-orch-6500',
  candidateTip: 'candidate456',
  ...overrides,
})

describe('fresh keyed writer task branch reuse', () => {
  test('a trunk caller reuses the candidate regardless of ancestry', () => {
    expect(decideTaskBranchReuse(facts({ callerOnTrunk: true }))).toEqual({ action: 'reuse' })
  })

  test('a non-trunk caller containing the candidate tip starts fresh', () => {
    expect(decideTaskBranchReuse(facts({ candidateIsAncestorOfCaller: true }))).toEqual({
      action: 'fresh',
    })
  })

  test('equal tips start fresh', () => {
    expect(
      decideTaskBranchReuse(
        facts({ candidateIsAncestorOfCaller: true, callerIsAncestorOfCandidate: true }),
      ),
    ).toEqual({ action: 'fresh' })
  })

  test('a candidate strictly ahead of the caller is reused', () => {
    expect(decideTaskBranchReuse(facts({ callerIsAncestorOfCandidate: true }))).toEqual({
      action: 'reuse',
    })
  })

  test('diverged tips refuse with both identities and the explicit-base remedy', () => {
    const decision = decideTaskBranchReuse(facts())
    expect(decision.action).toBe('refuse')
    if (decision.action !== 'refuse') throw new Error('expected refusal')
    const message = taskBranchDivergenceRefusal(decision)
    expect(message).toContain('DEV-969-orch-6500 tip candidate456')
    expect(message).toContain('feature/DEV-969 HEAD caller123')
    expect(message).toContain('have diverged')
    expect(message).toContain('--base feature/DEV-969')
  })

  test('a detached HEAD is treated as a non-trunk caller', () => {
    const decision = decideTaskBranchReuse(facts({ callerBranch: null }))
    expect(decision.action).toBe('refuse')
    if (decision.action !== 'refuse') throw new Error('expected refusal')
    expect(taskBranchDivergenceRefusal(decision)).toContain('detached HEAD HEAD caller123')
    expect(taskBranchDivergenceRefusal(decision)).toContain('--base caller123')
  })
})
