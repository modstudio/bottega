import { describe, expect, test } from 'bun:test'
import { classifyReviewTier, resolveTierRange, type TierRangeFacts } from './review-tier.ts'

describe('tier range resolution', () => {
  const facts = (overrides: Partial<TierRangeFacts> = {}): TierRangeFacts => ({
    from: 'trunk-tip',
    to: 'branch-tip',
    fromKind: 'commit',
    toKind: 'commit',
    mergeBase: 'fork-point',
    ...overrides,
  })

  test('replaces a moving trunk tip with the merge base', () => {
    expect(resolveTierRange(facts())).toEqual({ from: 'fork-point', to: 'branch-tip' })
  })

  test.each([
    ['from', facts({ fromKind: 'tree' }), 'trunk-tip'],
    ['to', facts({ toKind: 'tree' }), 'branch-tip'],
  ] as const)('refuses a tree %s endpoint', (_side, input, ref) => {
    const result = resolveTierRange(input)
    expect(result).toHaveProperty('refusal')
    expect('refusal' in result && result.refusal).toContain(ref)
  })

  test.each([
    ['from', facts({ fromKind: 'missing' }), 'trunk-tip'],
    ['to', facts({ toKind: 'missing' }), 'branch-tip'],
  ] as const)('refuses a missing %s endpoint', (_side, input, ref) => {
    const result = resolveTierRange(input)
    expect(result).toHaveProperty('refusal')
    expect('refusal' in result && result.refusal).toContain(ref)
    expect('refusal' in result && result.refusal).toContain('git fetch')
  })

  test('refuses a missing merge base with remedies for both causes', () => {
    const result = resolveTierRange(facts({ mergeBase: null }))
    expect(result).toHaveProperty('refusal')
    expect('refusal' in result && result.refusal).toContain('related histories')
    expect('refusal' in result && result.refusal).toContain('shallow clone')
    expect('refusal' in result && result.refusal).toContain('git fetch --deepen')
  })

  test('keeps healthy branch shorthand endpoints unchanged in effect', () => {
    expect(resolveTierRange(facts({ from: 'fork-point' }))).toEqual({
      from: 'fork-point',
      to: 'branch-tip',
    })
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
