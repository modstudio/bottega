import { describe, expect, test } from 'bun:test'
import { realpathOrSpelled, withoutTrailingSeparators } from '../git/checkout-identity.ts'
import {
  continuationBranchAvailability,
  continuationBranchPlan,
  parseWorktreeList,
  type ResumeTreeFacts,
  resumeCreationOptions,
  resumeTreePlan,
} from './resume-tree.ts'

const base: ResumeTreeFacts = {
  rootId: 3970,
  branch: 'technical/ADN-123-orch-3970',
  recordedTreeMatches: false,
  hasCreate: false,
  branchTip: 'branch-tip',
  retainedTip: 'retained-tip',
  recordedTip: 'recorded-tip',
}

const worktrees = parseWorktreeList(`worktree /projects/workshop
HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
branch refs/heads/main

worktree /projects/workshop/.claude/worktrees/orch-5931
HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
branch refs/heads/DEV-878-orch-5931

worktree /projects/workshop/.claude/worktrees/landing
HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
branch refs/heads/DEV-878-orch-5931
`)

describe('continuation branch availability', () => {
  test('compares paths after adapter-style trailing-separator normalization', () => {
    const canonicalPath = (path: string): string =>
      withoutTrailingSeparators(realpathOrSpelled(path))
    const recordedTreePath = canonicalPath('/projects/workshop/.claude/worktrees/orch-5931///')
    const canonicalWorktrees = worktrees.slice(0, 2).map((worktree) => ({
      ...worktree,
      path: canonicalPath(worktree.path),
    }))

    expect(recordedTreePath).toBe('/projects/workshop/.claude/worktrees/orch-5931')
    expect(
      continuationBranchAvailability('DEV-878-orch-5931', recordedTreePath, canonicalWorktrees),
    ).toEqual({ action: 'continue' })
  })

  test('refuses a continuation branch held by another tree and names its path', () => {
    expect(
      continuationBranchAvailability(
        'DEV-878-orch-5931',
        '/projects/workshop/.claude/worktrees/orch-5931',
        worktrees.slice(0, 1).concat(worktrees.slice(2)),
      ),
    ).toEqual({ action: 'refuse', holdingPath: '/projects/workshop/.claude/worktrees/landing' })
  })

  test("allows the chain's own recorded tree to hold the continuation branch", () => {
    expect(
      continuationBranchAvailability(
        'DEV-878-orch-5931',
        '/projects/workshop/.claude/worktrees/orch-5931',
        worktrees.slice(0, 2),
      ),
    ).toEqual({ action: 'continue' })
  })

  test('allows a continuation branch that is not checked out', () => {
    expect(
      continuationBranchAvailability(
        'DEV-912-orch-6044',
        '/projects/workshop/.claude/worktrees/orch-6044',
        worktrees,
      ),
    ).toEqual({ action: 'continue' })
  })
})

describe('resume tree decision', () => {
  test('attaches the matching recorded tree without requiring a recoverable tip', () => {
    expect(
      resumeTreePlan({
        ...base,
        recordedTreeMatches: true,
        branchTip: null,
        retainedTip: null,
        recordedTip: null,
      }),
    ).toEqual({
      action: 'attach-recorded',
      branch: 'technical/ADN-123-orch-3970',
      tip: null,
      tipSource: null,
      rootId: 3970,
    })
  })

  test('recreates the recorded branch through the Git fallback', () => {
    expect(resumeTreePlan(base)).toEqual({
      action: 'recreate-on-branch',
      branch: 'technical/ADN-123-orch-3970',
      existingBranch: 'technical/ADN-123-orch-3970',
      tip: 'branch-tip',
      tipSource: 'branch ref',
      rootId: 3970,
    })
  })

  test('recreates through the declared lifecycle before restoring the tip', () => {
    expect(resumeTreePlan({ ...base, hasCreate: true })).toEqual({
      action: 'recreate-then-restore',
      branch: 'technical/ADN-123-orch-3970',
      existingBranch: 'technical/ADN-123-orch-3970',
      tip: 'branch-tip',
      tipSource: 'branch ref',
      rootId: 3970,
    })
  })

  test('refuses when no retained tip exists', () => {
    expect(
      resumeTreePlan({ ...base, branchTip: null, retainedTip: null, recordedTip: null }),
    ).toEqual({
      action: 'refuse',
      branch: 'technical/ADN-123-orch-3970',
      tip: null,
      tipSource: null,
      rootId: 3970,
    })
  })

  test.each([
    ['branch ref', base, 'branch-tip'],
    ['retained ref', { ...base, branchTip: null }, 'retained-tip'],
    ['recorded close-out tip', { ...base, branchTip: null, retainedTip: null }, 'recorded-tip'],
  ] as const)('uses the %s tip before lower-precedence sources', (_name, facts, tip) => {
    expect(resumeTreePlan(facts)).toMatchObject({ action: 'recreate-on-branch', tip })
  })
})

describe('continuation branch decision', () => {
  test('rejects the mutation that lets the root branch override the latest turn branch and tip', () => {
    expect(
      continuationBranchPlan({
        latestBranch: 'DEV-623-orch-4286',
        latestBranchTip: 'checkpoint-tip',
        rootBranch: 'DEV-623-orch-4285',
      }),
    ).toEqual({
      branch: 'DEV-623-orch-4286',
      tip: 'checkpoint-tip',
      source: 'latest turn branch',
    })
  })

  test('rejects the mutation that reuses a latest turn branch after its ref is gone', () => {
    expect(
      continuationBranchPlan({
        latestBranch: 'DEV-623-orch-4286',
        latestBranchTip: null,
        rootBranch: 'DEV-623-orch-4285',
      }),
    ).toEqual({
      branch: 'DEV-623-orch-4285',
      tip: null,
      source: 'root retained branch',
    })
  })
})

describe('resume creation decision', () => {
  const plan = resumeTreePlan({ ...base, hasCreate: true })
  if (plan.action === 'attach-recorded' || plan.action === 'refuse') {
    throw new Error('bad fixture')
  }

  test('rejects passing the existing branch to a command-template create tool', () => {
    expect(resumeCreationOptions(plan, 'command-template')).toEqual({
      baseRef: 'branch-tip',
      existingBranch: undefined,
      existingBranchTip: undefined,
      useCreateTool: true,
    })
  })

  test('rejects minting a new branch or skipping provisioning for a tracked or inline recipe', () => {
    expect(resumeCreationOptions(plan, 'recipe')).toEqual({
      baseRef: undefined,
      existingBranch: 'technical/ADN-123-orch-3970',
      existingBranchTip: 'branch-tip',
      useCreateTool: true,
    })
  })

  test('rejects invoking a tool or minting a new branch for built-in Git creation', () => {
    expect(resumeCreationOptions(plan, 'built-in-git')).toEqual({
      baseRef: undefined,
      existingBranch: 'technical/ADN-123-orch-3970',
      existingBranchTip: 'branch-tip',
      useCreateTool: false,
    })
  })
})
