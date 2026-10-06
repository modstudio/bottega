import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { db } from '../database/db.ts'
import { preflight } from '../dispatch/dispatch-preflight.ts'
import { upsertProject } from '../project/projects.ts'
import {
  emptyReviewRefusal,
  implicitReviewRefusal,
  reviewArtifactBlock,
  reviewTrunkRef,
} from './review-target.ts'

describe('review target', () => {
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
    const priorDepth = process.env.ORCH_DEPTH
    const git = (...args: string[]) => {
      const result = spawnFixtureGitSync(args, { cwd: repo })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    }
    try {
      process.env.ORCH_DEPTH = '0'
      git('init', '-b', 'main')
      git('config', 'user.name', 'Fixture')
      git('config', 'user.email', 'fixture@example.com')
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      git('add', 'base.txt')
      git('commit', '-m', 'base')
      upsertProject({ name: 'implicit-review-preflight', path: repo, settings: { trunk: 'main' } })
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
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
