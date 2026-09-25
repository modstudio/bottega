import { describe, expect, test } from 'bun:test'
import {
  atomicRetryReuseDecision,
  decideRetryConversation,
  decideWritingRetryWorkspace,
  previousAttemptTaskPointer,
  type RetryPathDecision,
  renderWritingRetryPrompt,
} from './run-retry.ts'

const writing = {
  writesRepo: true,
  rulingsPresent: true,
  agentChanged: false,
  treeExists: true,
  treeLive: false,
  branchTipRelation: 'recorded' as const,
}

describe('retry path decision', () => {
  test.each([
    [{ writesRepo: false, rulingsPresent: true, agentChanged: true }, 'regular-retry'],
    [{ writesRepo: true, rulingsPresent: false, agentChanged: false }, 'continue'],
    [{ writesRepo: true, rulingsPresent: true, agentChanged: false }, 'needs-writing-workspace'],
    [{ writesRepo: true, rulingsPresent: false, agentChanged: true }, 'needs-writing-workspace'],
  ] as const)('selects conversation path %#', (facts, action) => {
    expect(decideRetryConversation(facts)).toEqual({ action })
  })

  test.each([
    [writing, { action: 'reuse-tree' }],
    [{ ...writing, treeExists: false }, { action: 'open-tree' }],
    [{ ...writing, treeLive: true }, { action: 'refuse-live-owner' }],
    [
      { ...writing, branchTipRelation: 'missing' as const },
      { action: 'refuse-branch', relation: 'missing' },
    ],
    [
      { ...writing, branchTipRelation: 'diverged' as const },
      { action: 'refuse-branch', relation: 'diverged' },
    ],
    [{ ...writing, branchTipRelation: 'descendant' as const }, { action: 'reuse-tree' }],
  ])('selects the expected outcome for %#', (facts, expected) => {
    expect(decideWritingRetryWorkspace(facts)).toEqual(expected as RetryPathDecision)
  })
})

test('atomic retry reuse requires the validated path, branch, and tip', () => {
  const facts = {
    pathExists: true,
    actualBranch: 'DEV-962-work',
    expectedBranch: 'DEV-962-work',
    actualHead: 'abc',
    validatedTip: 'abc',
  }
  expect(atomicRetryReuseDecision(facts)).toEqual({ action: 'reuse' })
  expect(atomicRetryReuseDecision({ ...facts, pathExists: false }).action).toBe('refuse')
  expect(atomicRetryReuseDecision({ ...facts, actualBranch: 'other' }).action).toBe('refuse')
  expect(atomicRetryReuseDecision({ ...facts, actualHead: 'def' }).action).toBe('refuse')
})

test('previous-attempt pointer prefers checkpoint, then latest turn, then root scratch', () => {
  expect(
    previousAttemptTaskPointer({
      checkpoint: 'checkpoint',
      latestScratch: 'latest',
      rootScratch: 'root',
    }),
  ).toBe('checkpoint')
  expect(
    previousAttemptTaskPointer({ checkpoint: null, latestScratch: 'latest', rootScratch: 'root' }),
  ).toBe('latest')
  expect(
    previousAttemptTaskPointer({ checkpoint: null, latestScratch: null, rootScratch: 'root' }),
  ).toBe('root')
})

test('the retry prompt puts the previous-attempt handoff after the spec and rulings', () => {
  expect(
    renderWritingRetryPrompt({
      originalSpec: 'Build the requested change.',
      continuationInstructions: [],
      rulings: 'RULINGS\nUse the existing shape.',
      commit: 'abc123',
      taskPointer: 'tests completed',
    }),
  ).toBe(
    'Build the requested change.\n\n---\n\n' +
      'RULINGS\nUse the existing shape.\n\n---\n\n' +
      "PREVIOUS ATTEMPT\n\nThis worktree already holds a previous attempt's work at abc123.\n" +
      'Last completed item: tests completed\nContinue from there rather than restart.',
  )
})

test('the retry prompt omits an absent progress pointer', () => {
  expect(
    renderWritingRetryPrompt({
      originalSpec: 'Build it.',
      continuationInstructions: [],
      rulings: null,
      commit: 'def456',
      taskPointer: null,
    }),
  ).not.toContain('Last completed item:')
})

test('the retry prompt carries continuation instructions in order after the spec', () => {
  expect(
    renderWritingRetryPrompt({
      originalSpec: 'Build it.',
      continuationInstructions: [
        { turnId: 12, at: '2026-09-25T12:00:00.000Z', instructions: 'Review 1621.' },
        {
          turnId: 14,
          at: '2026-09-25T13:00:00.000Z',
          instructions: 'worker-gate-tooling-change',
        },
      ],
      rulings: null,
      commit: 'def456',
      taskPointer: null,
    }),
  ).toBe(
    'Build it.\n\n---\n\n' +
      'INSTRUCTIONS GIVEN SINCE THE ORIGINAL SPEC\n\n' +
      'Turn 12 at 2026-09-25T12:00:00.000Z:\nReview 1621.\n\n' +
      'Turn 14 at 2026-09-25T13:00:00.000Z:\nworker-gate-tooling-change\n\n---\n\n' +
      "PREVIOUS ATTEMPT\n\nThis worktree already holds a previous attempt's work at def456.\n" +
      'Continue from there rather than restart.',
  )
})
