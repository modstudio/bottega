import { describe, expect, test } from 'bun:test'
import {
  claimedRunBranch,
  decideClaimTreePlan,
  resumeCreationLifecycle,
  resumeCreationTool,
  shouldResolveTaskBranch,
  taskBranchKey,
} from './run-claim-plan.ts'

test('claim branch selection records implicit, explicit, and ordinary worktree branches', () => {
  expect(claimedRunBranch(null, 'DEV-1147-implicit', 'DEV-1147-root', null)).toBe(
    'DEV-1147-implicit',
  )
  expect(claimedRunBranch('DEV-1147-explicit', null, 'DEV-1147-root', null)).toBe(
    'DEV-1147-explicit',
  )
  expect(claimedRunBranch(null, null, 'DEV-1147-root', null)).toBe('DEV-1147-root')
  expect(claimedRunBranch(null, null, null, 'DEV-1147-writer')).toBe('DEV-1147-writer')
  expect(claimedRunBranch(null, null, null, '')).toBeNull()
})

const defaultFacts = {
  hasResolvedTaskWorktree: false,
  forbidsRepo: false,
  repoJob: false,
  hasWorktree: false,
}

describe('claim tree plan', () => {
  test.each([
    {
      name: 'a resolved task worktree attaches ahead of every other mode',
      facts: {
        hasResolvedTaskWorktree: true,
        forbidsRepo: true,
        repoJob: true,
        hasWorktree: false,
      },
      expected: { mode: 'attach' as const },
    },
    {
      name: 'a job that forbids the repository isolates even when it is a repository job',
      facts: { ...defaultFacts, forbidsRepo: true, repoJob: true },
      expected: { mode: 'isolate' as const },
    },
    {
      name: 'a repository job without a tree creates',
      facts: { ...defaultFacts, repoJob: true },
      expected: { mode: 'create' as const },
    },
    {
      name: 'a repository job with a tree stays in the caller cwd',
      facts: { ...defaultFacts, repoJob: true, hasWorktree: true },
      expected: { mode: 'caller' as const },
    },
    {
      name: 'a non-repository job that permits the repository stays in the caller cwd',
      facts: defaultFacts,
      expected: { mode: 'caller' as const },
    },
  ])('$name', ({ facts, expected }) => {
    expect(decideClaimTreePlan(facts)).toEqual(expected)
  })
})

describe('task branch resolution eligibility', () => {
  const eligible = {
    repoJob: true,
    writesJob: true,
    hasWorktree: false,
    taskKey: 'DEV-831',
    isResume: false,
    hasExplicitBase: false,
  }

  test.each([
    { name: 'not a repository job', input: { ...eligible, repoJob: false } },
    { name: 'not a writing job', input: { ...eligible, writesJob: false } },
    { name: 'already has a worktree', input: { ...eligible, hasWorktree: true } },
    { name: 'has no task key', input: { ...eligible, taskKey: null } },
    {
      name: 'has an explicit base and is not resuming',
      input: { ...eligible, hasExplicitBase: true },
    },
  ])('returns false when $name', ({ input }) => {
    expect(shouldResolveTaskBranch(input)).toBe(false)
  })

  test('returns true for an eligible launch and for a resume with an explicit base', () => {
    expect(shouldResolveTaskBranch(eligible)).toBe(true)
    expect(shouldResolveTaskBranch({ ...eligible, isResume: true, hasExplicitBase: true })).toBe(
      true,
    )
  })
})

describe('task branch key', () => {
  test.each([
    { name: 'returns the launch key without a plan', hasResumePlan: false, expected: 'DEV-831' },
    { name: 'returns null when a plan is present', hasResumePlan: true, expected: null },
  ])('$name', ({ hasResumePlan, expected }) => {
    expect(taskBranchKey('DEV-831', hasResumePlan)).toBe(expected)
  })
})

describe('resume creation lifecycle', () => {
  test.each([
    {
      name: 'create takes precedence over recipe declarations',
      facts: { hasCreate: true, hasRecipe: true, hasRecipePath: true },
      expected: 'command-template',
    },
    {
      name: 'recipe is selected from an inline recipe',
      facts: { hasCreate: false, hasRecipe: true, hasRecipePath: false },
      expected: 'recipe',
    },
    {
      name: 'recipe is selected from a recipe path',
      facts: { hasCreate: false, hasRecipe: false, hasRecipePath: true },
      expected: 'recipe',
    },
    {
      name: 'built-in Git is the fallback',
      facts: { hasCreate: false, hasRecipe: false, hasRecipePath: false },
      expected: 'built-in-git',
    },
  ])('$name', ({ facts, expected }) => {
    expect(resumeCreationLifecycle(facts)).toBe(expected)
  })
})

describe('resume creation tool', () => {
  const tool = { create: 'worktree create' }

  test.each([
    { name: 'returns the project tool when requested', useCreateTool: true, expected: tool },
    {
      name: 'returns null when the project tool is bypassed',
      useCreateTool: false,
      expected: null,
    },
  ])('$name', ({ useCreateTool, expected }) => {
    expect(resumeCreationTool(useCreateTool, tool)).toBe(expected)
  })
})
