import { describe, expect, test } from 'bun:test'
import {
  classifyReviewTier,
  parseTierRange,
  resolveTierRange,
  type TierRangeEndpoint,
  type TierRangeFacts,
} from './review-tier.ts'

describe('tier range parsing', () => {
  test.each([
    ['a..b', { from: 'a', to: 'b' }],
    ['a...b', { from: 'a', to: 'b' }],
    ['v1.2..v1.3', { from: 'v1.2', to: 'v1.3' }],
  ] as const)('parses %s', (value, expected) => {
    expect(parseTierRange(value)).toEqual(expected)
  })

  test.each(['a..b..c', 'a....b'])('refuses invalid range %s with the accepted forms', (value) => {
    const result = parseTierRange(value)
    expect(result).toHaveProperty('refusal')
    expect(result && 'refusal' in result && result.refusal).toContain('<from>..<to>')
    expect(result && 'refusal' in result && result.refusal).toContain('<from>...<to>')
  })

  test('returns null for a plain branch name', () => {
    expect(parseTierRange('feature-branch')).toBeNull()
  })
})

describe('tier range resolution', () => {
  const endpoint = (
    ref: string,
    kind: TierRangeEndpoint['kind'] = 'commit',
    commit: string | null = `${ref}-commit`,
  ): TierRangeEndpoint => ({ ref, commit: kind === 'commit' ? commit : null, kind })
  const facts = (overrides: Partial<TierRangeFacts> = {}): TierRangeFacts => ({
    from: endpoint('trunk-tip'),
    to: endpoint('branch-tip'),
    mergeBase: 'fork-point',
    ...overrides,
  })

  test('replaces a moving trunk tip with the merge base', () => {
    expect(resolveTierRange(facts())).toEqual({ from: 'fork-point', to: 'branch-tip-commit' })
  })

  test.each([
    ['tree', facts({ from: endpoint('trunk-tree', 'tree') }), 'trunk-tree'],
    ['tree', facts({ to: endpoint('branch-tree', 'tree') }), 'branch-tree'],
    ['other', facts({ to: endpoint('branch-blob', 'other') }), 'branch-blob'],
  ] as const)('refuses a %s endpoint and names its typed ref', (_kind, input, ref) => {
    const result = resolveTierRange(input)
    expect(result).toHaveProperty('refusal')
    expect('refusal' in result && result.refusal).toContain(ref)
    expect('refusal' in result && result.refusal).not.toContain(`${ref}-commit`)
  })

  test.each([
    ['from', facts({ from: endpoint('missing-trunk', 'unresolvable') }), 'missing-trunk'],
    ['to', facts({ to: endpoint('missing-branch', 'unresolvable') }), 'missing-branch'],
  ] as const)('refuses an unresolvable %s endpoint with both remedies', (_side, input, ref) => {
    const result = resolveTierRange(input)
    expect(result).toHaveProperty('refusal')
    expect('refusal' in result && result.refusal).toContain(ref)
    expect('refusal' in result && result.refusal).toContain('fetch it')
    expect('refusal' in result && result.refusal).toContain('revision expression')
    expect('refusal' in result && result.refusal).toContain('check the spelling')
  })

  test('refuses a missing merge base with remedies for both causes', () => {
    const result = resolveTierRange(facts({ mergeBase: null }))
    expect(result).toHaveProperty('refusal')
    expect('refusal' in result && result.refusal).toContain('related histories')
    expect('refusal' in result && result.refusal).toContain('shallow clone')
    expect('refusal' in result && result.refusal).toContain('git fetch --deepen')
  })

  test('keeps healthy branch shorthand endpoints unchanged in effect', () => {
    expect(
      resolveTierRange(facts({ from: endpoint('fork-point', 'commit', 'fork-point') })),
    ).toEqual({
      from: 'fork-point',
      to: 'branch-tip-commit',
    })
  })

  test('uses a tag endpoint peeled to its commit', () => {
    expect(
      resolveTierRange(facts({ to: endpoint('release-tag', 'commit', 'peeled-release-commit') })),
    ).toEqual({ from: 'fork-point', to: 'peeled-release-commit' })
  })
})

describe('review tier classification', () => {
  const cases = [
    {
      name: 'docs only',
      files: [{ path: 'docs/readme.md', insertions: 900, deletions: 0 }],
      tier: 0,
      risk: 0,
      size: 0,
    },
    {
      name: 'large web change',
      files: [{ path: 'hub/web/src/app.tsx', insertions: 600, deletions: 0 }],
      tier: 3,
      risk: 1,
      size: 3,
    },
    {
      name: 'nine small product files',
      files: Array.from({ length: 9 }, (_, i) => ({
        path: `hub/web/src/${i}.tsx`,
        insertions: 3,
        deletions: 0,
      })),
      tier: 2,
      risk: 1,
      size: 2,
    },
    {
      name: 'tests only',
      files: [{ path: 'orchestrator/src/run.test.ts', insertions: 700, deletions: 0 }],
      tier: 0,
      risk: 0,
      size: 0,
    },
  ] as const

  for (const item of cases)
    test(item.name, () => {
      const actual = classifyReviewTier({ files: [...item.files] })
      expect(actual).toMatchObject({ tier: item.tier, risk: item.risk, size: item.size })
      expect(actual.reasons.every(Boolean)).toBeTrue()
    })

  test('excluded churn in a mixed diff does not inflate product size', () => {
    const actual = classifyReviewTier({
      files: [
        { path: 'docs/huge.md', insertions: 1000, deletions: 0 },
        { path: 'hub/web/src/tiny.tsx', insertions: 5, deletions: 0 },
      ],
    })
    expect(actual).toMatchObject({ risk: 1, size: 0, tier: 1 })
    expect(actual.reasons.join('\n')).toContain('5 product lines')
  })

  test('workflow step instructions require review', () => {
    const actual = classifyReviewTier({
      files: [{ path: '.agents/workflow-steps/dispatch.md', insertions: 1, deletions: 0 }],
    })
    expect(actual).toMatchObject({ risk: 1, tier: 1 })
    expect(actual.reasons.join('\n')).toContain('workflow instructions')
  })

  test('agent skill instructions require review', () => {
    const actual = classifyReviewTier({
      files: [{ path: '.claude/skills/review/SKILL.md', insertions: 1, deletions: 0 }],
    })
    expect(actual).toMatchObject({ risk: 1, tier: 1 })
    expect(actual.reasons.join('\n')).toContain('agent skill')
  })

  test.each(['docs/guide.md', '.agents/rules/example.md'])(
    '%s remains excluded from review',
    (path) => {
      expect(
        classifyReviewTier({ files: [{ path, insertions: 500, deletions: 0 }] }),
      ).toMatchObject({ tier: 0, risk: 0, size: 0 })
    },
  )

  test('instruction lines count toward size', () => {
    const actual = classifyReviewTier({
      files: [{ path: '.agents/workflows/code-review.md', insertions: 51, deletions: 0 }],
    })
    expect(actual).toMatchObject({ risk: 1, size: 2, tier: 2 })
    expect(actual.reasons.join('\n')).toContain('51 product lines')
  })

  test('unlisted product code defaults to risk two', () => {
    const actual = classifyReviewTier({
      files: [{ path: 'scripts/check.ts', insertions: 1, deletions: 0 }],
    })
    expect(actual).toMatchObject({ risk: 2, tier: 2 })
    expect(actual.reasons.join('\n')).toContain('unlisted product path scripts/check.ts')
  })

  test('docs and tests stay risk zero inside hot directories', () => {
    for (const path of [
      'orchestrator/src/README.md',
      'orchestrator/src/x.test.ts',
      'shared/README.md',
      'shared/x.test.ts',
      'orchestrator/hooks/README.md',
      'orchestrator/hooks/x.test.ts',
    ]) {
      expect(
        classifyReviewTier({ files: [{ path, insertions: 500, deletions: 0 }] }),
      ).toMatchObject({ tier: 0, risk: 0, size: 0 })
    }
  })

  test('fixtures are excluded by review classification without changing FileKind', () => {
    expect(
      classifyReviewTier({
        files: [{ path: 'orchestrator/src/fixtures/example.ts', insertions: 500, deletions: 0 }],
      }),
    ).toMatchObject({ tier: 0, risk: 0, size: 0 })
  })
})
