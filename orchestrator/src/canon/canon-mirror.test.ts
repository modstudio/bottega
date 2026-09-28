import { describe, expect, test } from 'bun:test'
import { categorizeFile } from '../../../shared/file-kind.ts'
import { classifyReviewTier } from '../review/review-tier.ts'
import { canonMirrorCommitBody, decideCanonMirrorMerge } from './canon-mirror.ts'

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
