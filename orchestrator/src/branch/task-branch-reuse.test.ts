import { describe, expect, test } from 'bun:test'
import {
  decideTaskBranchReuse,
  decideTaskBranchSessionReuse,
  type TaskBranchReuseFacts,
  taskBranchDivergenceRefusal,
  taskBranchSessionRefusal,
} from './task-branch-reuse.ts'

describe('task branch nominating session ownership', () => {
  test('same-session mutation: changing includes to excludes refuses the owner', () => {
    expect(decideTaskBranchSessionReuse('session-a', ['session-a'])).toEqual({ action: 'reuse' })
  })

  test('other-session mutation: accepting any non-null owner permits cross-session reuse', () => {
    expect(decideTaskBranchSessionReuse('session-b', ['session-a'])).toEqual({ action: 'refuse' })
  })

  test('mixed-session mutation: requiring every nominator to match refuses an owned branch', () => {
    expect(decideTaskBranchSessionReuse('session-b', ['session-a', 'session-b'])).toEqual({
      action: 'reuse',
    })
  })

  test('no-session mutation: treating null as equal silently reuses an unattributed branch', () => {
    expect(decideTaskBranchSessionReuse(null, [null])).toEqual({ action: 'refuse' })
  })

  test('message-field mutation: the refusal names branch, tip, runs, sessions, and both bases', () => {
    const message = taskBranchSessionRefusal({
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
      runIds: [7000, 7001],
      trunk: 'main',
      worktree: null,
    })
    expect(message).toContain('DEV-1225-orch-7000 tip abc123')
    expect(message).toContain('runs 7000, 7001: session-a')
    expect(message).toContain('--base main')
    expect(message).toContain('--base DEV-1225-orch-7000')
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
