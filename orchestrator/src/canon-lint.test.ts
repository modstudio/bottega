import { describe, expect, test } from 'bun:test'
import {
  ALWAYS_ON_TOTAL_BYTES,
  CARD_BYTES,
  CHAIN_BYTES,
  CONTEXT_BYTES,
  ENTRY_BYTES,
  REFERENCE_BYTES,
  RULE_BYTES,
} from './canon-budget.ts'
import {
  type CanonFile,
  type CanonFinding,
  type CanonLintInput,
  introducedCanonFindings,
  lintCanon,
} from './canon-lint.ts'

const lint = (files: CanonFile[], extra: Partial<Omit<CanonLintInput, 'files'>> = {}) =>
  lintCanon({
    files,
    trackedPaths: extra.trackedPaths ?? [],
    packageScripts: extra.packageScripts ?? [],
    sourceTexts: extra.sourceTexts ?? [],
  })
const rules = (files: CanonFile[], rule: string) =>
  lint(files).findings.filter((finding) => finding.rule === rule)
const inputRules = (text: string, rule: string, extra: Partial<Omit<CanonLintInput, 'files'>>) =>
  lint([{ path: 'AGENTS.md', text }], extra).findings.filter((finding) => finding.rule === rule)
const text = (bytes: number) => 'x'.repeat(bytes)
const card = (extra = '') =>
  `## Purpose\n\nP\n\n## Belongs here\n\nB\n\n## Does not belong here\n\nD\n\n## May depend on\n\nM\n${extra}`
const ruleDoc = (body = 'Current rule.') => `---\ndescription: A rule\nalways: true\n---\n${body}\n`
const contextDoc = (body = 'Current context.') =>
  `---\ndescription: A context\npaths:\n  - src/**\n---\n${body}\n`
const referenceDoc = (body = 'Current reference.') =>
  `---\ndescription: A reference\n---\n${body}\n`

describe('canon tier size rules', () => {
  test('entry size reports only above its byte cap', () => {
    expect(
      rules([{ path: 'AGENTS.md', text: text(ENTRY_BYTES + 1) }], 'canon/size-entry'),
    ).toHaveLength(1)
    expect(rules([{ path: 'AGENTS.md', text: text(ENTRY_BYTES) }], 'canon/size-entry')).toEqual([])
  })

  test('always-on total reports only above its combined cap', () => {
    const entry = { path: 'AGENTS.md', text: text(ENTRY_BYTES) }
    expect(
      rules(
        [
          entry,
          { path: '.agents/rules/a.md', text: text(ALWAYS_ON_TOTAL_BYTES - ENTRY_BYTES + 1) },
        ],
        'canon/size-always-on',
      ),
    ).toHaveLength(1)
    expect(
      rules(
        [entry, { path: '.agents/rules/a.md', text: text(ALWAYS_ON_TOTAL_BYTES - ENTRY_BYTES) }],
        'canon/size-always-on',
      ),
    ).toEqual([])
  })

  for (const fixture of [
    ['rule', '.agents/rules/a.md', RULE_BYTES, 'canon/size-rule'],
    ['context', '.agents/contexts/a.md', CONTEXT_BYTES, 'canon/size-context'],
    ['reference', '.agents/reference/a.md', REFERENCE_BYTES, 'canon/size-reference'],
    ['card', 'src/AGENTS.md', CARD_BYTES, 'canon/size-card'],
  ] as const) {
    test(`${fixture[0]} size reports only above its byte cap`, () => {
      expect(rules([{ path: fixture[1], text: text(fixture[2] + 1) }], fixture[3])).toHaveLength(1)
      expect(rules([{ path: fixture[1], text: text(fixture[2]) }], fixture[3])).toEqual([])
    })
  }
})

describe('canon chain sizing', () => {
  test('sums a published context through its folder symlink exactly once', () => {
    const rootBytes = 16_000
    const contextBytes = CHAIN_BYTES - rootBytes + 1
    const result = lint([
      { path: 'AGENTS.md', text: text(rootBytes) },
      { path: '.agents/contexts/src.md', text: text(contextBytes) },
      {
        path: 'src/AGENTS.md',
        text: text(contextBytes),
        symlinkTarget: '../.agents/contexts/src.md',
      },
    ])
    expect(result.findings.filter((finding) => finding.rule === 'canon/size-chain')).toEqual([
      expect.objectContaining({ file: 'src/AGENTS.md' }),
    ])
    expect(result.summary.chains.find((chain) => chain.path === 'src/AGENTS.md')?.bytes).toBe(
      rootBytes + contextBytes,
    )
    expect(result.summary.tiers.cards).toEqual([])
  })

  test('accepts a chain at its cap', () => {
    expect(
      rules(
        [
          { path: 'AGENTS.md', text: text(16_000) },
          { path: 'src/AGENTS.md', text: text(CHAIN_BYTES - 16_000) },
        ],
        'canon/size-chain',
      ),
    ).toEqual([])
  })
})

describe('canon prose rules', () => {
  test('history reports narration outside code and ignores fenced and inline code', () => {
    const result = rules(
      [
        {
          path: 'AGENTS.md',
          text: 'This was called old.\n`This was called inline.`\n```\nThis was called fenced.\n```\n',
        },
      ],
      'canon/history',
    )
    expect(result).toEqual([expect.objectContaining({ line: 1 })])
    expect(rules([{ path: 'AGENTS.md', text: 'Current rule.' }], 'canon/history')).toEqual([])
  })

  test('issue reports generic task keys, exempts standard tokens, and ignores fenced code', () => {
    const result = rules(
      [
        {
          path: 'AGENTS.md',
          text: 'Known issue here.\n`workaround`\n`DEV-572`\nAB-2418\nSTAR-4622\nUTF-8 SHA-256 ISO-8601 RFC-3339\n```\nDEV-573 known issue\n```\n',
        },
      ],
      'canon/issue',
    )
    expect(result.map((finding) => finding.line)).toEqual([1, 3, 4, 5])
    expect(rules([{ path: 'AGENTS.md', text: 'Current rule.' }], 'canon/issue')).toEqual([])
  })
})

describe('canon current reference rules', () => {
  test('reference paths accept tracked paths and matching globs, and reject missing ones', () => {
    const extra = { trackedPaths: ['src/real.ts', 'scripts/check.ts'] }
    expect(
      inputRules(
        '`src/real.ts` and `src/*.ts` and [source](src/real.ts)',
        'canon/reference-path',
        extra,
      ),
    ).toEqual([])
    expect(
      inputRules(
        '`src/missing.ts` and `src/nope/*.ts` and [missing](src/also-missing.ts)',
        'canon/reference-path',
        extra,
      ),
    ).toHaveLength(3)
  })

  test('placeholders and home- or variable-rooted paths are never candidates', () => {
    expect(
      inputRules(
        '`src/<name>.ts`, `src/{name}.ts`, `<module>.test.ts`, `~/.claude.json` and `$ORCH_SCRATCH/reply.json`',
        'canon/reference-path',
        { trackedPaths: ['src/real.ts'] },
      ),
    ).toEqual([])
    expect(
      inputRules('`ghost.ts`', 'canon/reference-path', { trackedPaths: ['src/real.ts'] }),
    ).toHaveLength(1)
  })

  test('reference exemptions are exact', () => {
    expect(
      inputRules('`orchestrator/orch.db`', 'canon/reference-path', {
        trackedPaths: ['orchestrator/src/orch.ts'],
      }),
    ).toEqual([])
    expect(
      inputRules('`orchestrator/orch.db-copy`', 'canon/reference-path', {
        trackedPaths: ['orchestrator/src/orch.ts'],
      }),
    ).toHaveLength(1)
  })

  test('module-relative symbol references report identifiers absent from every suffix match', () => {
    expect(
      inputRules('`worktree.ts:ghost`', 'canon/reference-symbol', {
        trackedPaths: ['orchestrator/src/worktree.ts'],
        sourceTexts: [{ path: 'orchestrator/src/worktree.ts', text: 'const other = true' }],
      }),
    ).toEqual([
      expect.objectContaining({
        message: 'orchestrator/src/worktree.ts do not declare identifier ghost',
      }),
    ])
  })

  test('module-relative symbol references accept a declaration-shaped occurrence', () => {
    expect(
      inputRules('`worktree.ts:ghost`', 'canon/reference-symbol', {
        trackedPaths: ['orchestrator/src/worktree.ts'],
        sourceTexts: [{ path: 'orchestrator/src/worktree.ts', text: 'export function ghost() {}' }],
      }),
    ).toEqual([])
  })

  test('module-relative symbol references reject an import-only occurrence', () => {
    expect(
      inputRules('`worktree.ts:ghost`', 'canon/reference-symbol', {
        trackedPaths: ['orchestrator/src/worktree.ts'],
        sourceTexts: [
          { path: 'orchestrator/src/worktree.ts', text: "import { ghost } from './other.ts'" },
        ],
      }),
    ).toHaveLength(1)
  })

  test('module-relative symbol references reject a call-only occurrence', () => {
    expect(
      inputRules('`worktree.ts:ghost`', 'canon/reference-symbol', {
        trackedPaths: ['orchestrator/src/worktree.ts'],
        sourceTexts: [{ path: 'orchestrator/src/worktree.ts', text: 'ghost()' }],
      }),
    ).toHaveLength(1)
  })

  test('extension references report a path finding when no resolution matches', () => {
    expect(
      inputRules('`nothere.ts`', 'canon/reference-path', {
        trackedPaths: ['orchestrator/src/worktree.ts'],
      }),
    ).toEqual([expect.objectContaining({ message: 'repository path nothere.ts is not tracked' })])
  })

  test('file references resolve from the repository root', () => {
    expect(
      inputRules('`orchestrator/src/worktree.ts`', 'canon/reference-path', {
        trackedPaths: ['orchestrator/src/worktree.ts'],
      }),
    ).toEqual([])
  })

  test('file references resolve relative to the citing canon directory', () => {
    const result = lint([{ path: 'orchestrator/AGENTS.md', text: '`src/worktree.ts`' }], {
      trackedPaths: ['orchestrator/src/worktree.ts'],
    })
    expect(result.findings.filter((finding) => finding.rule === 'canon/reference-path')).toEqual([])
  })

  test('line anchors are findings while an identifier anchor is not', () => {
    const extra = {
      trackedPaths: ['file.ts'],
      sourceTexts: [{ path: 'file.ts', text: 'const realName = true' }],
    }
    expect(inputRules('`file.ts:12`', 'canon/line-anchor', extra)).toHaveLength(1)
    expect(inputRules('`file.ts:realName`', 'canon/line-anchor', extra)).toEqual([])
  })

  test('code references require a tracked-source occurrence', () => {
    const sourceTexts = [{ path: 'src/real.ts', text: 'function liveName() {}' }]
    expect(inputRules('`liveName()`', 'canon/reference-code', { sourceTexts })).toEqual([])
    expect(inputRules('`deadName()`', 'canon/reference-code', { sourceTexts })).toHaveLength(1)
  })

  test('script references require a package script and include fenced commands', () => {
    expect(
      inputRules('run `bun run check`\n```sh\nnpm run check\n```', 'canon/reference-script', {
        packageScripts: ['check'],
      }),
    ).toEqual([])
    expect(
      inputRules('```sh\nbun run absent\n```', 'canon/reference-script', {
        packageScripts: ['check'],
      }),
    ).toHaveLength(1)
    expect(
      inputRules('bun run scripts/check.ts', 'canon/reference-script', {
        packageScripts: [],
      }),
    ).toEqual([])
  })

  test('numerals report prose values but exclude technical words, markers, and code', () => {
    expect(inputRules('109 scripts\n82%', 'canon/numeral', {})).toEqual([
      expect.objectContaining({ line: 1, message: expect.stringContaining('109') }),
      expect.objectContaining({ line: 2, message: expect.stringContaining('82') }),
    ])
    expect(
      inputRules(
        'UTF-8 and arm64\n1. step\n`109 scripts`\n[target](src/82.ts)',
        'canon/numeral',
        {},
      ),
    ).toEqual([])
  })
})

describe('canon strict comparison', () => {
  const sizeFinding = (file: string, measuredBytes: number): CanonFinding => ({
    file,
    line: 1,
    rule: 'canon/size-card',
    message: `measured ${measuredBytes} bytes; limit 2048 bytes`,
    measuredBytes,
  })

  test('size findings pass at or below baseline and fail above it or on a new file', () => {
    const baseline = [sizeFinding('src/AGENTS.md', 3_000)]
    expect(introducedCanonFindings(baseline, [sizeFinding('src/AGENTS.md', 3_000)])).toEqual([])
    expect(introducedCanonFindings(baseline, [sizeFinding('src/AGENTS.md', 2_999)])).toEqual([])
    expect(introducedCanonFindings(baseline, [sizeFinding('src/AGENTS.md', 3_001)])).toEqual([
      sizeFinding('src/AGENTS.md', 3_001),
    ])
    expect(introducedCanonFindings(baseline, [sizeFinding('new/AGENTS.md', 3_000)])).toEqual([
      sizeFinding('new/AGENTS.md', 3_000),
    ])
  })
})

describe('canon structure rules', () => {
  test('frontmatter requires descriptions and context paths', () => {
    expect(
      rules(
        [{ path: '.agents/contexts/a.md', text: '---\ndescription:\npaths: []\n---\n' }],
        'canon/frontmatter',
      ),
    ).toHaveLength(1)
    expect(
      rules(
        [
          { path: '.agents/rules/a.md', text: ruleDoc() },
          { path: '.agents/contexts/a.md', text: contextDoc() },
          { path: '.agents/reference/a.md', text: referenceDoc() },
        ],
        'canon/frontmatter',
      ),
    ).toEqual([])
  })

  test('tier declarations follow their authoritative locations', () => {
    expect(
      rules(
        [
          {
            path: '.agents/rules/a.md',
            text: '---\ndescription: A rule\nalways: true\npaths: [src/**]\n---\n',
          },
        ],
        'canon/tier-declaration',
      ),
    ).toEqual([
      expect.objectContaining({
        message: 'rule files require always: true and must not declare paths',
      }),
    ])
    expect(
      rules(
        [
          {
            path: '.agents/contexts/a.md',
            text: '---\ndescription: A context\npaths: [src/**]\nalways: true\n---\n',
          },
        ],
        'canon/tier-declaration',
      ),
    ).toEqual([
      expect.objectContaining({
        message: 'context files require paths and must not declare always',
      }),
    ])
    expect(
      rules(
        [
          { path: '.agents/rules/a.md', text: ruleDoc() },
          { path: '.agents/contexts/a.md', text: contextDoc() },
        ],
        'canon/tier-declaration',
      ),
    ).toEqual([])
  })

  test('folder cards report one missing required heading and accept all four', () => {
    const missing = card().replace('## May depend on\n', '')
    expect(rules([{ path: 'src/AGENTS.md', text: missing }], 'canon/card-headings')).toEqual([
      expect.objectContaining({ message: 'missing ## May depend on' }),
    ])
    expect(rules([{ path: 'src/AGENTS.md', text: card() }], 'canon/card-headings')).toEqual([])
  })

  test('aliases must target sibling AGENTS.md and canon symlinks must resolve', () => {
    expect(
      rules(
        [
          { path: 'AGENTS.md', text: card() },
          { path: 'CLAUDE.md', text: '', symlinkTarget: 'missing.md' },
        ],
        'canon/symlink',
      ),
    ).toHaveLength(2)
    expect(
      rules(
        [
          { path: 'AGENTS.md', text: card() },
          { path: 'CLAUDE.md', text: card(), symlinkTarget: 'AGENTS.md' },
        ],
        'canon/symlink',
      ),
    ).toEqual([])
  })
})
