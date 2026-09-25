import { describe, expect, test } from 'bun:test'
import {
  decideTaskBranchReuse,
  type TaskBranchReuseFacts,
  taskBranchDivergenceRefusal,
} from './task-branch-reuse.ts'

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
