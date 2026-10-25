import { describe, expect, test } from 'bun:test'
import {
  parseTierRange,
  resolveTierRange,
  type TierRangeEndpoint,
  type TierRangeFacts,
} from './review-tier.ts'
import {
  classifyReviewTier,
  combineReviewTier,
  tierThreeRiskPaths,
} from './review-tier-classifier.ts'

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
  const classify = (
    files: Parameters<typeof classifyReviewTier>[0]['files'],
    risk?: Parameters<typeof classifyReviewTier>[0]['risk'],
  ) => classifyReviewTier({ files, risk })

  const webRisk = {
    paths: [{ pattern: '^hub/web/', tier: 1 as const, reason: 'web surface' }],
    unlisted: 2 as const,
  }

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
      const actual = classify(
        [...item.files],
        item.name === 'large web change' || item.name === 'nine small product files'
          ? webRisk
          : undefined,
      )
      expect(actual).toMatchObject({ tier: item.tier, risk: item.risk, size: item.size })
      expect(actual.reasons.every(Boolean)).toBeTrue()
    })

  test('excluded churn in a mixed diff does not inflate product size', () => {
    const actual = classify(
      [
        { path: 'docs/huge.md', insertions: 1000, deletions: 0 },
        { path: 'hub/web/src/tiny.tsx', insertions: 5, deletions: 0 },
      ],
      webRisk,
    )
    expect(actual).toMatchObject({ risk: 1, size: 0, tier: 0 })
    expect(actual.reasons.join('\n')).toContain('5 product lines')
    expect(actual.reasons.join('\n')).toContain('size 0 lowered risk 1 by one')
  })

  test('workflow step instructions are risk one', () => {
    const actual = classify([
      { path: '.agents/workflow-steps/dispatch.md', insertions: 1, deletions: 0 },
    ])
    expect(actual).toMatchObject({ risk: 1, size: 0, tier: 0 })
    expect(actual.reasons.join('\n')).toContain('workflow instructions')
    expect(actual.reasons.join('\n')).toContain('size 0 lowered risk 1 by one')
  })

  test('agent skill instructions are risk one', () => {
    const actual = classify([
      { path: '.agents/skills/review/SKILL.md', insertions: 1, deletions: 0 },
    ])
    expect(actual).toMatchObject({ risk: 1, size: 0, tier: 0 })
    expect(actual.reasons.join('\n')).toContain('agent skill')
    expect(actual.reasons.join('\n')).toContain('size 0 lowered risk 1 by one')
  })

  test('a move into workflow instructions is classified from no-renames numstat rows', () => {
    const actual = classify([
      { path: '.agents/rules/moved.md', insertions: 0, deletions: 12 },
      { path: '.agents/workflow-steps/moved.md', insertions: 12, deletions: 0 },
    ])
    expect(actual).toMatchObject({ risk: 1, tier: 1 })
    expect(actual.reasons.join('\n')).toContain('workflow instructions')
  })

  test.each(['docs/guide.md', '.agents/rules/example.md'])(
    '%s remains excluded from review',
    (path) => {
      expect(classify([{ path, insertions: 500, deletions: 0 }])).toMatchObject({
        tier: 0,
        risk: 0,
        size: 0,
      })
    },
  )

  test('instruction lines count toward size', () => {
    const actual = classify([
      { path: '.agents/workflows/code-review.md', insertions: 51, deletions: 0 },
    ])
    expect(actual).toMatchObject({ risk: 1, size: 2, tier: 2 })
    expect(actual.reasons.join('\n')).toContain('51 product lines')
  })

  test('unlisted product code defaults to risk two', () => {
    const actual = classify([{ path: 'scripts/check.ts', insertions: 1, deletions: 0 }])
    expect(actual).toMatchObject({ risk: 2, size: 0, tier: 1 })
    expect(actual.reasons.join('\n')).toContain('unlisted product path scripts/check.ts')
    expect(actual.reasons.join('\n')).toContain('size 0 lowered risk 2 by one')
  })

  test('docs and tests stay risk zero in product directories', () => {
    for (const path of [
      'orchestrator/src/README.md',
      'orchestrator/src/x.test.ts',
      'shared/README.md',
      'shared/x.test.ts',
      'orchestrator/hooks/README.md',
      'orchestrator/hooks/x.test.ts',
    ]) {
      expect(classify([{ path, insertions: 500, deletions: 0 }])).toMatchObject({
        tier: 0,
        risk: 0,
        size: 0,
      })
    }
  })

  test('fixtures are excluded by review classification without changing FileKind', () => {
    expect(
      classify([{ path: 'orchestrator/src/fixtures/example.ts', insertions: 500, deletions: 0 }]),
    ).toMatchObject({ tier: 0, risk: 0, size: 0 })
  })

  test('orchestrator source under src/doc is product and counts toward size', () => {
    const actual = classify(
      [{ path: 'orchestrator/src/doc/docs.ts', insertions: 25, deletions: 0 }],
      {
        paths: [{ pattern: '^orchestrator/src/', tier: 2, reason: 'orchestrator source' }],
        unlisted: 2,
      },
    )
    expect(actual).toMatchObject({ risk: 2, size: 1, tier: 2 })
    expect(actual.reasons.join('\n')).toContain('orchestrator source')
    expect(actual.reasons.join('\n')).toContain('25 product lines')
  })

  test('a declared map pattern wins over its unlisted value', () => {
    const actual = classifyReviewTier({
      files: [{ path: 'src/security.ts', insertions: 1, deletions: 0 }],
      risk: {
        paths: [{ pattern: '^src/security\\.ts$', tier: 3, reason: 'security boundary' }],
        unlisted: 1,
      },
    })
    expect(actual).toMatchObject({ risk: 3, size: 0, tier: 2 })
    expect(actual.reasons[0]).toContain('security boundary')
    expect(actual.reasons.join('\n')).toContain('size 0 lowered risk 3 by one')
  })

  test('a declared map unlisted value applies to unmatched product files', () => {
    const actual = classifyReviewTier({
      files: [{ path: 'src/constant.ts', insertions: 1, deletions: 0 }],
      risk: { paths: [], unlisted: 1 },
    })
    expect(actual).toMatchObject({ risk: 1, size: 0, tier: 0 })
    expect(actual.reasons[0]).toContain('project unlisted risk 1 applied')
    expect(actual.reasons.join('\n')).toContain('size 0 lowered risk 1 by one')
  })

  test('no declaration uses the fail-closed default without the repository shared-path rule', () => {
    const actual = classifyReviewTier({
      files: [{ path: 'shared/value.ts', insertions: 1, deletions: 0 }],
    })
    expect(actual).toMatchObject({ risk: 2, size: 0, tier: 1 })
    expect(actual.reasons[0]).toContain('fail-closed default risk 2 applied')
    expect(actual.reasons[0]).not.toContain('cross-concern shared code')
    expect(actual.reasons.join('\n')).toContain('size 0 lowered risk 2 by one')
  })

  test('a test-only hook change carries no declared risk, while product code names the risk', () => {
    const risk = {
      paths: [{ pattern: '^orchestrator/hooks/', tier: 3 as const, reason: 'repository hooks' }],
      unlisted: 2 as const,
    }
    expect(
      classifyReviewTier({
        files: [{ path: 'orchestrator/hooks/test_x.py', insertions: 500, deletions: 0 }],
        risk,
      }),
    ).toMatchObject({ risk: 0, size: 0, tier: 0 })

    const actual = classifyReviewTier({
      files: [
        { path: 'orchestrator/hooks/test_x.py', insertions: 500, deletions: 0 },
        { path: 'orchestrator/hooks/x.py', insertions: 1, deletions: 0 },
      ],
      risk,
    })
    expect(actual).toMatchObject({ risk: 3, size: 0, tier: 2 })
    expect(actual.reasons[0]).toBe('risk 3: orchestrator/hooks/x.py (repository hooks)')
    expect(actual.reasons.join('\n')).toContain('size 0 lowered risk 3 by one')
  })

  test('tests and fixtures under declared source paths carry no risk', () => {
    const actual = classifyReviewTier({
      files: [
        { path: 'orchestrator/src/a/a.test.ts', insertions: 500, deletions: 0 },
        { path: 'orchestrator/src/a/a.fixture.ts', insertions: 500, deletions: 0 },
        { path: 'orchestrator/src/a/fixtures/f.json', insertions: 500, deletions: 0 },
      ],
      risk: {
        paths: [{ pattern: '^orchestrator/src/', tier: 2, reason: 'orchestrator source' }],
        unlisted: 2,
      },
    })
    expect(actual).toMatchObject({ risk: 0, size: 0, tier: 0 })
  })

  test('agent instructions keep their universal tier ahead of test and fixture exclusions', () => {
    const actual = classifyReviewTier({
      files: [{ path: '.agents/skills/test_x.py', insertions: 1, deletions: 0 }],
      risk: {
        paths: [{ pattern: '.*', tier: 3, reason: 'project catch-all' }],
        unlisted: 2,
      },
    })
    expect(actual).toMatchObject({ risk: 1, size: 0, tier: 0 })
    expect(actual.reasons[0]).toBe('risk 1: .agents/skills/test_x.py (agent skill)')
    expect(actual.reasons.join('\n')).toContain('size 0 lowered risk 1 by one')
  })

  test('documentation under a declared risk path keeps that risk', () => {
    const actual = classifyReviewTier({
      files: [{ path: 'orchestrator/src/README.md', insertions: 500, deletions: 0 }],
      risk: {
        paths: [{ pattern: '^orchestrator/src/', tier: 2, reason: 'orchestrator source' }],
        unlisted: 2,
      },
    })
    expect(actual).toMatchObject({ risk: 2, size: 0, tier: 1 })
    expect(actual.reasons[0]).toBe('risk 2: orchestrator/src/README.md (orchestrator source)')
    expect(actual.reasons.join('\n')).toContain('size 0 lowered risk 2 by one')
  })

  test('names only paths whose surface risk is tier three', () => {
    expect(
      tierThreeRiskPaths(
        [
          { path: 'src/ordinary.ts', insertions: 1, deletions: 0 },
          { path: 'src/security.ts', insertions: 1, deletions: 0 },
          { path: 'src/security.test.ts', insertions: 1, deletions: 0 },
        ],
        {
          paths: [
            { pattern: '^src/security', tier: 3, reason: 'security boundary' },
            { pattern: '^src/', tier: 2, reason: 'product source' },
          ],
          unlisted: 1,
        },
      ),
    ).toEqual(['src/security.ts'])
  })

  const precedenceCases: {
    name: string
    path: string
    risk: NonNullable<Parameters<typeof classifyReviewTier>[0]['risk']>
    expected: { risk: number; tier: number; reason: string }
  }[] = [
    {
      name: 'the first overlapping project pattern wins',
      path: 'src/security.ts',
      risk: {
        paths: [
          { pattern: '^src/', tier: 1, reason: 'first broad match' },
          { pattern: '^src/security\\.ts$', tier: 3, reason: 'later exact match' },
        ],
        unlisted: 2,
      },
      expected: { risk: 1, tier: 0, reason: 'risk 1: src/security.ts (first broad match)' },
    },
    {
      name: 'the universal agent-instruction pattern wins over a project catch-all',
      path: '.agents/skills/review/SKILL.md',
      risk: {
        paths: [{ pattern: '.*', tier: 3, reason: 'project catch-all' }],
        unlisted: 2,
      },
      expected: {
        risk: 1,
        tier: 0,
        reason: 'risk 1: .agents/skills/review/SKILL.md (agent skill)',
      },
    },
  ]

  test.each(precedenceCases)('$name', ({ path, risk, expected }) => {
    const actual = classify([{ path, insertions: 1, deletions: 0 }], risk)
    expect(actual).toMatchObject({ risk: expected.risk, tier: expected.tier })
    expect(actual.reasons[0]).toBe(expected.reason)
  })

  test('size 0 at risk 3 gives tier 2 and the reason line says it was lowered', () => {
    const actual = classifyReviewTier({
      files: [{ path: 'src/hot.ts', insertions: 2, deletions: 0 }],
      risk: {
        paths: [{ pattern: '^src/hot\\.ts$', tier: 3, reason: 'hot path' }],
        unlisted: 1,
      },
    })
    expect(actual).toMatchObject({ risk: 3, size: 0, tier: 2 })
    expect(actual.reasons).toContain('tier 2: size 0 lowered risk 3 by one')
  })

  test('a firm path at size 0 stays risk 3', () => {
    const actual = classifyReviewTier({
      files: [{ path: 'orchestrator/src/database/db.ts', insertions: 2, deletions: 0 }],
      risk: {
        paths: [
          {
            pattern: '^orchestrator/src/database/db\\.ts$',
            tier: 3,
            reason: 'schema and DDL',
            firm: true,
          },
        ],
        unlisted: 2,
      },
    })
    expect(actual).toMatchObject({ risk: 3, size: 0, tier: 3 })
    expect(actual.reasons.join('\n')).not.toContain('lowered')
  })

  test('size 1 and above is unchanged', () => {
    const actual = classifyReviewTier({
      files: [{ path: 'src/hot.ts', insertions: 11, deletions: 0 }],
      risk: {
        paths: [{ pattern: '^src/hot\\.ts$', tier: 3, reason: 'hot path' }],
        unlisted: 1,
      },
    })
    expect(actual).toMatchObject({ risk: 3, size: 1, tier: 3 })
    expect(actual.reasons.join('\n')).not.toContain('lowered')
  })

  test('a firm path at the max risk keeps size 0 at that risk when other files are lower', () => {
    const actual = classifyReviewTier({
      files: [
        { path: 'src/db.ts', insertions: 1, deletions: 0 },
        { path: 'src/other.ts', insertions: 1, deletions: 0 },
      ],
      risk: {
        paths: [
          { pattern: '^src/db\\.ts$', tier: 3, reason: 'schema', firm: true },
          { pattern: '^src/', tier: 2, reason: 'product source' },
        ],
        unlisted: 1,
      },
    })
    expect(actual).toMatchObject({ risk: 3, size: 0, tier: 3 })
  })

  test('a firm path below the max risk does not block lowering the non-firm max', () => {
    const actual = classifyReviewTier({
      files: [
        { path: 'src/hot.ts', insertions: 1, deletions: 0 },
        { path: 'src/db.ts', insertions: 1, deletions: 0 },
      ],
      risk: {
        paths: [
          { pattern: '^src/db\\.ts$', tier: 2, reason: 'schema', firm: true },
          { pattern: '^src/hot\\.ts$', tier: 3, reason: 'hot path' },
        ],
        unlisted: 1,
      },
    })
    expect(actual).toMatchObject({ risk: 3, size: 0, tier: 2 })
    expect(actual.reasons).toContain('tier 2: size 0 lowered risk 3 by one')
  })
})

describe('combined review tier', () => {
  test.each([
    [
      { risk: 3, size: 0, firm: false },
      { tier: 2, lowered: true },
    ],
    [
      { risk: 3, size: 0, firm: true },
      { tier: 3, lowered: false },
    ],
    [
      { risk: 3, size: 1, firm: false },
      { tier: 3, lowered: false },
    ],
    [
      { risk: 1, size: 0, firm: false },
      { tier: 0, lowered: true },
    ],
    [
      { risk: 0, size: 0, firm: false },
      { tier: 0, lowered: false },
    ],
    [
      { risk: 1, size: 2, firm: false },
      { tier: 2, lowered: false },
    ],
  ] as const)('combineReviewTier(%j)', (input, expected) => {
    expect(combineReviewTier(input)).toEqual(expected)
  })
})
