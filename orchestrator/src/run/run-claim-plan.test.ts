import { describe, expect, test } from 'bun:test'
import { taskBranchLandingTreeRefusal } from '../branch/task-branch.ts'
import {
  claimedRunBranch,
  decideClaimTreePlan,
  resumeCreationLifecycle,
  resumeCreationTool,
  retryRootTreeValidation,
  shouldResolveTaskBranch,
  taskBranchKey,
} from './run-claim-plan.ts'

describe('retry-root tree validation', () => {
  test('returns the writing branch and tip from a retry-root tree plan', () => {
    expect(
      retryRootTreeValidation({
        kind: 'retry-root',
        treePlan: { branch: 'DEV-1261-writer', tip: 'writer-tip' },
        readOnlyBase: null,
      }),
    ).toEqual({ branch: 'DEV-1261-writer', tip: 'writer-tip' })
  })

  test('returns no validation for a read-only retry-root without a tree plan', () => {
    expect(
      retryRootTreeValidation({
        kind: 'retry-root',
        treePlan: null,
        readOnlyBase: 'reader-base',
      }),
    ).toBeNull()
  })

  test('returns no validation for a non-retry resume', () => {
    expect(
      retryRootTreeValidation({
        kind: 'continue',
        treePlan: { branch: 'DEV-1261-writer', tip: 'writer-tip' },
        readOnlyBase: null,
      }),
    ).toBeNull()
  })
})

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
  resolvedTaskWorktree: null,
  forbidsRepo: false,
  repoJob: false,
  hasWorktree: false,
}

describe('claim tree plan', () => {
  test.each([
    {
      name: "a candidate in a writer's tree still attaches",
      facts: {
        resolvedTaskWorktree: {
          path: '/tmp/DEV-1398-writer',
          branch: 'DEV-1398-writer',
          ownerJob: 'implement',
          freshBase: 'main',
        },
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
      name: 'a candidate with no tree still creates',
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

  test.each(['hook-tree', 'landing-tree', 'canon-mirror', 'issue-before-tree'])(
    'a candidate in architect lifecycle tree %s is refused',
    (ownerJob) => {
      const ruling = decideClaimTreePlan({
        ...defaultFacts,
        repoJob: true,
        resolvedTaskWorktree: {
          path: '/tmp/DEV-1398-landing',
          branch: 'DEV-1398-writer',
          ownerJob,
          freshBase: 'main',
        },
      })
      expect(ruling).toEqual({
        mode: 'refuse',
        path: '/tmp/DEV-1398-landing',
        branch: 'DEV-1398-writer',
        freshBase: 'main',
        ownerJob,
      })
      if (ruling.mode !== 'refuse') throw new Error('expected a lifecycle-tree refusal')
      expect(taskBranchLandingTreeRefusal(ruling)).toContain(`architect-owned ${ownerJob} tree`)
      expect(taskBranchLandingTreeRefusal(ruling)).toContain('start from trunk with --base main')
      expect(taskBranchLandingTreeRefusal(ruling)).toContain('land through that tree')
    },
  )
})

describe('task branch resolution eligibility', () => {
  const eligible = {
    repoJob: true,
    writesJob: true,
    hasWorktree: false,
    taskKey: 'DEV-831',
    isResume: false,
    hasExplicitBase: false,
    taskBranchSupplied: true,
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
    {
      name: 'has no explicitly supplied task branch and is not resuming',
      input: { ...eligible, taskBranchSupplied: false, isResume: false },
    },
  ])('returns false when $name', ({ input }) => {
    expect(shouldResolveTaskBranch(input)).toBe(false)
  })

  test('returns true for an eligible launch and for a resume with an explicit base', () => {
    expect(shouldResolveTaskBranch(eligible)).toBe(true)
    expect(
      shouldResolveTaskBranch({ ...eligible, taskBranchSupplied: false, isResume: true }),
    ).toBe(true)
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
