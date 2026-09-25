import { describe, expect, test } from 'bun:test'
import { decideRetryPath, type RetryPathDecision, renderWritingRetryPrompt } from './run-retry.ts'

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
    [{ ...writing, writesRepo: false }, { action: 'regular-retry' }],
    [{ ...writing, rulingsPresent: false }, { action: 'continue' }],
    [{ ...writing, rulingsPresent: false, agentChanged: true }, { action: 'reuse-tree' }],
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
    expect(decideRetryPath(facts)).toEqual(expected as RetryPathDecision)
  })
})

test('the retry prompt puts the previous-attempt handoff after the spec and rulings', () => {
  expect(
    renderWritingRetryPrompt({
      originalSpec: 'Build the requested change.',
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
      rulings: null,
      commit: 'def456',
      taskPointer: null,
    }),
  ).not.toContain('Last completed item:')
})
