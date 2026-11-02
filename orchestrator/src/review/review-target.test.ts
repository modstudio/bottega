import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { db } from '../database/db.ts'
import { preflight } from '../dispatch/dispatch-preflight.ts'
import { isCommitShapedBranch } from '../project/branch-name.ts'
import { reviewBranchForCommit, upsertProject } from '../project/projects.ts'
import { claimedRunBranch } from '../run/run-claim-plan.ts'
import { branchReviewLineage } from './review-lineage.ts'
import {
  decideCommitReviewBranch,
  emptyReviewRefusal,
  implicitReviewBranch,
  implicitReviewBranchFrom,
  implicitReviewRefusal,
  reviewArtifactBlock,
  reviewTargetRef,
  reviewTrunkRef,
} from './review-target.ts'

describe('review target', () => {
  test('a commit target from its branch tree records branch review lineage', () => {
    const branch = decideCommitReviewBranch({
      reviewRef: '5c156c96b',
      commit: '5c156c96b1234567890123456789012345678901',
      launchKey: 'DEV-2031',
      recordedBranch: null,
      callerBranch: 'DEV-2031-review-branch',
      callerBranchContainsCommit: true,
    })
    const claimed = claimedRunBranch(branch, null, null, 'DEV-2031-review-branch')
    if (!claimed) throw new Error('expected the resolved branch to be claimed')

    expect(branch).toBe('DEV-2031-review-branch')
    expect(
      branchReviewLineage('DEV-2031-review-branch', [
        {
          mintedBranch: 'DEV-2031-review-branch',
          launchBase: 'main',
          launchKey: 'DEV-2031',
          headCommit: '5c156c96b1234567890123456789012345678901',
        },
      ]),
    ).toContain(claimed)
  })

  test('a recorded same-task branch wins over the caller tree', () => {
    expect(
      decideCommitReviewBranch({
        reviewRef: '5c156c96b',
        commit: '5c156c96b1234567890123456789012345678901',
        launchKey: 'DEV-2031',
        recordedBranch: 'DEV-2031-recorded',
        callerBranch: 'DEV-2031-caller',
        callerBranchContainsCommit: true,
      }),
    ).toBe('DEV-2031-recorded')
  })

  test('a commit-shaped recorded row is skipped for an older real branch', () => {
    const commit = '5c156c96b1234567890123456789012345678901'
    expect(
      reviewBranchForCommit(commit, 'DEV-2031', [
        { branch: '5c156c96b', headCommit: commit, launchKey: 'DEV-2031' },
        { branch: 'DEV-2031-real', headCommit: commit, launchKey: 'DEV-2031' },
      ]),
    ).toBe('DEV-2031-real')
  })

  test('a commit outside the caller branch is refused with the branch remedy', () => {
    expect(() =>
      decideCommitReviewBranch({
        reviewRef: '5c156c96b',
        commit: '5c156c96b1234567890123456789012345678901',
        launchKey: 'DEV-2031',
        recordedBranch: null,
        callerBranch: 'DEV-2031-caller',
        callerBranchContainsCommit: false,
      }),
    ).toThrow('caller: DEV-2031-caller')
    expect(() =>
      decideCommitReviewBranch({
        reviewRef: '5c156c96b',
        commit: '5c156c96b1234567890123456789012345678901',
        launchKey: 'DEV-2031',
        recordedBranch: null,
        callerBranch: 'DEV-2031-caller',
        callerBranchContainsCommit: false,
      }),
    ).toThrow('dispatch with --review <branch>')
  })

  test('a commit target from detached HEAD is refused', () => {
    expect(() =>
      decideCommitReviewBranch({
        reviewRef: '5c156c96b',
        commit: '5c156c96b1234567890123456789012345678901',
        launchKey: 'DEV-2031',
        recordedBranch: null,
        callerBranch: null,
        callerBranchContainsCommit: false,
      }),
    ).toThrow('caller: detached HEAD')
  })

  test('commit-shaped branch values are refused while ordinary branches remain valid', () => {
    expect(isCommitShapedBranch('5c156c9')).toBeTrue()
    expect(isCommitShapedBranch('5c156c96b1234567890123456789012345678901')).toBeTrue()
    expect(isCommitShapedBranch('main')).toBeFalse()
    expect(isCommitShapedBranch('DEV-2031-orch-review')).toBeFalse()
    expect(isCommitShapedBranch('worktree-dev-2016-harper-dep')).toBeFalse()
    expect(() => claimedRunBranch('5c156c96b', null, null, null)).toThrow(
      'dispatch with --review <branch>',
    )
  })

  test('implicit review branch excludes trunk and detached HEAD', () => {
    expect(implicitReviewBranch).toBeFunction()
    expect(implicitReviewBranchFrom('DEV-1147-branch', 'main')).toBe('DEV-1147-branch')
    expect(implicitReviewBranchFrom('main', 'main')).toBeNull()
    expect(implicitReviewBranchFrom(null, 'main')).toBeNull()
  })

  test('names the resolved artifact and makes checkout HEAD authoritative', () => {
    const prompt = reviewArtifactBlock({
      branch: 'DEV-911-fix',
      commit: 'caf69b0d11111111111111111111111111111111',
      base: 'b0583f6522222222222222222222222222222222',
    })

    expect(prompt).toContain('Branch: DEV-911-fix')
    expect(prompt).toContain('HEAD: caf69b0d11111111111111111111111111111111')
    expect(prompt).toContain('Base: b0583f6522222222222222222222222222222222')
    expect(prompt).toContain("checkout's HEAD is the artifact under review")
    expect(prompt).toContain('change is Base..HEAD')
    expect(prompt).toContain('provenance.reviewed_commit')
  })

  test('uses the remote-tracking trunk when it exists', () => {
    expect(reviewTrunkRef(true, 'main')).toBe('origin/main')
  })

  test('falls back to the local trunk when no remote-tracking ref exists', () => {
    expect(reviewTrunkRef(false, 'main')).toBe('main')
  })

  test('uses a remote-only branch while retaining its unqualified branch name', () => {
    expect(
      reviewTargetRef({
        reviewRef: 'DEV-1852-remote',
        branch: 'DEV-1852-remote',
        localBranchExists: false,
        remoteBranchExists: true,
        commitExists: true,
      }),
    ).toEqual({ kind: 'branch', ref: 'refs/remotes/origin/DEV-1852-remote' })
  })

  test('a missing review branch names the fetch remedy', () => {
    expect(
      reviewTargetRef({
        reviewRef: 'DEV-1852-missing',
        branch: 'DEV-1852-missing',
        localBranchExists: false,
        remoteBranchExists: false,
        commitExists: false,
      }),
    ).toEqual({
      kind: 'refuse',
      message:
        'cannot resolve --review DEV-1852-missing: neither refs/heads/DEV-1852-missing nor refs/remotes/origin/DEV-1852-missing exists, and DEV-1852-missing is not a local commit; cleared by: git fetch origin DEV-1852-missing',
    })
  })

  test('a review range names the accepted forms instead of a fetch remedy', () => {
    expect(
      reviewTargetRef({
        reviewRef: '9c2b4223e..9cb4aa5eb',
        branch: '9c2b4223e..9cb4aa5eb',
        localBranchExists: false,
        remoteBranchExists: false,
        commitExists: false,
      }),
    ).toEqual({
      kind: 'refuse',
      message:
        'cannot resolve --review 9c2b4223e..9cb4aa5eb: a commit range is not a review target; cleared by: pass a branch, run id or single revision',
    })
  })

  test('refuses a ref whose commit is its trunk merge base', () => {
    expect(
      emptyReviewRefusal('1234567890abcdef', '1234567890abcdef', 'mistaken-base', 'main'),
    ).toBe(
      'refused: --review mistaken-base resolves to 12345678, which is already on main, so there is no change to review. Pass the branch under review (the ref whose commits are not on main), not its base.',
    )
  })

  test('allows a commit after its trunk merge base', () => {
    expect(emptyReviewRefusal('branch-tip', 'fork-point', 'feature', 'main')).toBeNull()
  })

  test('refuses an empty implicit target with artifact-selection remedies', () => {
    expect(
      implicitReviewRefusal({
        changedPathCount: 0,
        carry: false,
        trunk: 'main',
        base: '1234567890abcdef',
        head: 'abcdef1234567890',
        measuredCwd: '/tmp/main-checkout',
        callerChoseCwd: false,
      }),
    ).toBe(
      'refused: implicit review target 12345678..abcdef12 against main has no changed paths. Pass --review <branch under review>, or --cwd <worktree of the change>, or --carry for uncommitted work. Prompt text does not select the artifact.',
    )
  })

  test('an explicitly selected cwd is named and is not offered as a remedy', () => {
    const refusal = implicitReviewRefusal({
      changedPathCount: 0,
      carry: false,
      trunk: 'main',
      base: '1234567890abcdef',
      head: 'abcdef1234567890',
      measuredCwd: '/tmp/change-tree',
      callerChoseCwd: true,
    })

    expect(refusal).toContain('/tmp/change-tree')
    expect(refusal).not.toContain('--cwd <worktree of the change>')
    expect(refusal).toContain('--review <branch under review>')
    expect(refusal).toContain('--carry for uncommitted work')
  })

  test('allows changed and unmeasurable implicit targets, including carried changes', () => {
    const target = {
      carry: false,
      trunk: 'main',
      base: 'base',
      head: 'head',
      measuredCwd: '/tmp/main-checkout',
      callerChoseCwd: false,
    }
    expect(implicitReviewRefusal({ ...target, changedPathCount: 1 })).toBeNull()
    expect(implicitReviewRefusal({ ...target, carry: true, changedPathCount: 1 })).toBeNull()
    expect(implicitReviewRefusal({ ...target, changedPathCount: null })).toBeNull()
  })

  test('preflight distinguishes plain, resolved, and already-reserved implicit targets', () => {
    const repo = mkdtempSync(join(tmpdir(), 'implicit-review-preflight-'))
    const priorDepth = process.env.BOTTEGA_DEPTH
    const git = (...args: string[]) => {
      const result = spawnFixtureGitSync(args, { cwd: repo })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    }
    try {
      process.env.BOTTEGA_DEPTH = '0'
      git('init', '-b', 'main')
      git('config', 'user.name', 'Fixture')
      git('config', 'user.email', 'fixture@example.com')
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      git('add', 'base.txt')
      git('commit', '-m', 'base')
      upsertProject({
        recordId: newRecordId(),
        name: 'implicit-review-preflight',
        path: repo,
        settings: { trunk: 'main' },
      })
      const before = db().query<{ count: number }, []>('SELECT COUNT(*) AS count FROM run').get()!

      expect(() =>
        preflight(
          'review-lens',
          repo,
          undefined,
          undefined,
          undefined,
          false,
          false,
          'correctness',
        ),
      ).toThrow('has no changed paths')
      expect(() =>
        preflight(
          'review-lens',
          repo,
          undefined,
          undefined,
          undefined,
          false,
          false,
          'correctness',
          undefined,
          false,
          undefined,
          true,
        ),
      ).not.toThrow()
      expect(() =>
        preflight('review-lens', repo, undefined, undefined, undefined, false, true, 'correctness'),
      ).not.toThrow()
      expect(db().query<{ count: number }, []>('SELECT COUNT(*) AS count FROM run').get()).toEqual(
        before,
      )
    } finally {
      if (priorDepth === undefined) delete process.env.BOTTEGA_DEPTH
      else process.env.BOTTEGA_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
