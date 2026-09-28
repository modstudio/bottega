import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { categorizeFile } from '../../../shared/file-kind.ts'
import { classifyReviewTier } from '../review/review-tier.ts'
import { applyHydration } from './canon-apply.ts'
import {
  canonMirrorCommitBody,
  canonMirrorMergeArgs,
  decideCanonMirrorMerge,
  screenCanonMirrorError,
} from './canon-mirror.ts'

describe('canon mirror commit body', () => {
  test('lists each changed path with latest store revision operation and reason', () => {
    expect(
      canonMirrorCommitBody([
        { path: 'AGENTS.md', revision: 'rev-2', op: 'update', reason: 'tighten rule' },
        {
          path: '.agents/rules/new.md',
          revision: 'rev-1',
          op: 'create',
          reason: 'add rule',
        },
      ]),
    ).toBe(
      '.agents/rules/new.md\nRevision: rev-1\nOperation: create\nReason: add rule\n\n' +
        'AGENTS.md\nRevision: rev-2\nOperation: update\nReason: tighten rule',
    )
  })
})

describe('canon mirror merge decision', () => {
  test('merges only an unchanged checked auto publication', () => {
    expect(
      decideCanonMirrorMerge({
        shipLevel: 'auto',
        headMatches: true,
        baseUnchanged: true,
        checks: 'passed',
      }),
    ).toEqual({ merge: true })
  })

  test.each([
    ['review', true, true, 'passed', 'ship autonomy is review'],
    ['auto', false, true, 'passed', 'pull-request head does not match'],
    ['auto', true, false, 'passed', 'landing branch changed'],
    ['auto', true, true, 'pending', 'GitHub checks are pending'],
    ['auto', true, true, 'failed', 'GitHub checks are failed'],
  ] as const)(
    'leaves open when a merge predicate fails',
    (shipLevel, headMatches, baseUnchanged, checks, reason) => {
      expect(decideCanonMirrorMerge({ shipLevel, headMatches, baseUnchanged, checks })).toEqual({
        merge: false,
        reason: expect.stringContaining(reason),
      })
    },
  )
})

test('generated canon directory links classify as tier-zero docs', () => {
  for (const path of ['.claude/rules', '.agents/rules/contexts']) {
    expect(categorizeFile(path)).toBe('docs')
    expect(classifyReviewTier({ files: [{ path, insertions: 1, deletions: 1 }] })).toMatchObject({
      tier: 0,
      risk: 0,
      size: 0,
    })
  }
})

test('merge binds gh to the pushed head commit', () => {
  expect(canonMirrorMergeArgs(42, 'abc123')).toEqual([
    'gh',
    'pr',
    'merge',
    '42',
    '--squash',
    '--match-head-commit',
    'abc123',
  ])
})

test('secret-shaped command failures are withheld', () => {
  expect(screenCanonMirrorError(new Error('gh failed: token=abc123'))).toBe(
    'command failed: output withheld because it resembles a secret',
  )
})

test('hydration refuses a symlinked ancestor directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'canon-apply-symlink-'))
  const outside = mkdtempSync(join(tmpdir(), 'canon-apply-outside-'))
  try {
    mkdirSync(join(root, '.agents'))
    symlinkSync(outside, join(root, '.agents', 'rules'))
    expect(() =>
      applyHydration(root, {
        writes: [{ path: '.agents/rules/guard.md', body: 'guard\n' }],
        deletes: [],
        links: [],
      }),
    ).toThrow('symlinked ancestor')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
