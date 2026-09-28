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
  canonFrontmatter,
  introducedCanonFindings,
  lintCanon,
} from './canon-lint.ts'
import { CODEX_PROJECT_DOC_MAX_BYTES } from './canon-load.ts'

const lint = (files: CanonFile[], extra: Partial<Omit<CanonLintInput, 'files'>> = {}) =>
  lintCanon({
    files,
    codexProjectDoc: true,
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
  test('Codex project doc size names the limit and largest contributing rows', () => {
    const result = lint([
      { path: 'AGENTS.md', text: text(16_000) },
      {
        path: '.agents/rules/large.md',
        text: `---\ndescription: Large\nalways: true\n---\n${text(17_000)}`,
      },
    ])
    const finding = result.findings.find(({ rule }) => rule === 'canon/size-codex-project-doc')

    expect(finding?.file).toBe('AGENTS.override.md')
    expect(finding?.message).toContain(`limit ${CODEX_PROJECT_DOC_MAX_BYTES} bytes`)
    expect(finding?.message).toContain('largest contributing rows:')
    expect(finding?.message).toContain('.agents/rules/large.md')
    expect(finding?.message).toContain('AGENTS.md')
  })

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
          text: 'Known issue here.\n`workaround`\n`DEV-572`\nAB-2418\nSTAR-4622\nUTF-8 SHA-256 ISO-8601 RFC-3339\nPSR-12\nPEP-8\nECMA-262\nCVE-2024-3094\n```\nDEV-573 known issue\n```\n',
        },
      ],
      'canon/issue',
    )
    expect(result.map((finding) => finding.line)).toEqual([1, 3, 4, 5])
    expect(rules([{ path: 'AGENTS.md', text: 'Current rule.' }], 'canon/issue')).toEqual([])
  })

  test('dates report outside code', () => {
    expect(
      rules([{ path: 'AGENTS.md', text: 'Current on 2026-09-23.\n`2026-09-24`' }], 'canon/date'),
    ).toEqual([expect.objectContaining({ line: 1 })])
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
      inputRules('`scripts/worktree`', 'canon/reference-path', {
        trackedPaths: ['scripts/actual.ts'],
      }),
    ).toEqual([])
    expect(
      inputRules('`scripts/worktree/missing`', 'canon/reference-path', {
        trackedPaths: ['scripts/actual.ts'],
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

  test('heading references accept a matching Markdown heading', () => {
    expect(
      inputRules('[rule](docs/rules.md#current-rule)', 'canon/reference-heading', {
        trackedPaths: ['docs/rules.md'],
        sourceTexts: [{ path: 'docs/rules.md', text: '# Current rule\n' }],
      }),
    ).toEqual([])
  })

  test('heading references report a missing fragment', () => {
    const extra = {
      trackedPaths: ['docs/rules.md'],
      sourceTexts: [{ path: 'docs/rules.md', text: '# Current rule\n' }],
    }
    for (const reference of ['[rule](docs/rules.md#former-rule)', '`docs/rules.md#former-rule`']) {
      expect(inputRules(reference, 'canon/reference-heading', extra)).toEqual([
        expect.objectContaining({
          message: 'Markdown heading docs/rules.md#former-rule does not resolve',
        }),
      ])
    }
  })

  test('inline-code heading references accept a matching fragment', () => {
    expect(
      inputRules('`See docs/rules.md#current-rule`', 'canon/reference-heading', {
        trackedPaths: ['docs/rules.md'],
        sourceTexts: [{ path: 'docs/rules.md', text: '# Current rule\n' }],
      }),
    ).toEqual([])
  })

  test('inline code with a bare hash is not a heading reference', () => {
    expect(inputRules('`#N` and `#preparedHeaders`', 'canon/reference-heading', {})).toEqual([])
  })

  test('inline code with a Markdown path reports a missing fragment', () => {
    expect(
      inputRules('`docs/rules.md#stale`', 'canon/reference-heading', {
        trackedPaths: ['docs/rules.md'],
        sourceTexts: [{ path: 'docs/rules.md', text: '# Current rule\n' }],
      }),
    ).toEqual([
      expect.objectContaining({
        message: 'Markdown heading docs/rules.md#stale does not resolve',
      }),
    ])
  })

  test('Markdown links with a bare fragment report a missing heading', () => {
    expect(inputRules('[x](#stale)', 'canon/reference-heading', {})).toEqual([
      expect.objectContaining({ message: 'Markdown heading #stale does not resolve' }),
    ])
  })

  test('bare heading fragments resolve against the citing file', () => {
    expect(
      inputRules('# Current rule\n\nSee [the rule](#current-rule).', 'canon/reference-heading', {}),
    ).toEqual([])
  })

  test('duplicate heading fragments resolve with github-slugger suffixes', () => {
    expect(
      inputRules(
        '# Current rule\n\n## Repeated\n\n## Repeated\n\nSee [the second](#repeated-1).',
        'canon/reference-heading',
        {},
      ),
    ).toEqual([])
  })

  test('code references require a tracked production occurrence', () => {
    const sourceTexts = [{ path: 'src/real.ts', text: 'liveName()' }]
    expect(inputRules('`liveName()`', 'canon/reference-code', { sourceTexts })).toEqual([])
    expect(inputRules('`deadName()`', 'canon/reference-code', { sourceTexts })).toHaveLength(1)
  })

  test('code references reject an identifier found only in a comment', () => {
    expect(
      inputRules('`commentedName()`', 'canon/reference-code', {
        sourceTexts: [{ path: 'src/real.ts', text: '// commentedName()' }],
      }),
    ).toHaveLength(1)
  })

  test('code references reject an identifier found only in a multi-line block comment', () => {
    expect(
      inputRules('`commentedName()`', 'canon/reference-code', {
        sourceTexts: [
          { path: 'src/real.ts', text: '/* commentary\ncommentedName()\nstill commentary */' },
        ],
      }),
    ).toHaveLength(1)
  })

  test('code references retain generator methods and PHP attributes', () => {
    expect(
      inputRules('`items()` `Route()`', 'canon/reference-code', {
        sourceTexts: [
          { path: 'src/items.ts', text: 'class Items {\n  *items() { yield 1 }\n}' },
          { path: 'src/Controller.php', text: "#[Route('/items')]\nfinal class Controller {}" },
        ],
      }),
    ).toEqual([])
  })

  test('code references reject occurrences found only in test files', () => {
    expect(
      inputRules('`testOnlyName()`', 'canon/reference-code', {
        sourceTexts: [{ path: 'src/real.test.ts', text: 'function testOnlyName() {}' }],
      }),
    ).toHaveLength(1)
  })

  test('code references accept a declared constant', () => {
    expect(
      inputRules('`CURRENT_LIMIT`', 'canon/reference-code', {
        sourceTexts: [{ path: 'src/limits.ts', text: 'export const CURRENT_LIMIT = 3' }],
      }),
    ).toEqual([])
  })

  test('code references accept occurrences in string literals and ordinary code', () => {
    expect(
      inputRules('`refund_due_at` `createServer()`', 'canon/reference-code', {
        sourceTexts: [
          { path: 'src/schema.ts', text: "column('refund_due_at')" },
          { path: 'src/server.ts', text: 'const server = createServer(options)' },
        ],
      }),
    ).toEqual([])
  })

  test('code references catch absent and shell-comment-only environment names', () => {
    expect(
      inputRules('`ORCH_LOCAL_BASE_URL` `LOCAL_CONTEXT_TOKENS`', 'canon/reference-code', {
        sourceTexts: [
          { path: 'src/env.ts', text: 'const current = ORCH_MODEL_HOST_URL' },
          { path: 'bin/serve.sh', text: '# LOCAL_CONTEXT_TOKENS selects the window' },
        ],
      }),
    ).toHaveLength(2)
  })

  test('symbol references accept uppercase environment variable reads', () => {
    const sourceTexts = [
      {
        path: 'src/env.ts',
        text: [
          'process.env.PROCESS_DOT_NAME',
          "process.env['PROCESS_SINGLE_NAME']",
          'process.env["PROCESS_DOUBLE_NAME"]',
          'Bun.env.BUN_DOT_NAME',
        ].join('\n'),
      },
      {
        path: 'src/env.py',
        text: [
          'os.environ.get("ENVIRON_GET_NAME")',
          "os.environ['ENVIRON_SINGLE_NAME']",
          'os.getenv("GETENV_NAME")',
        ].join('\n'),
      },
    ]
    for (const [path, name] of [
      ['src/env.ts', 'PROCESS_DOT_NAME'],
      ['src/env.ts', 'PROCESS_SINGLE_NAME'],
      ['src/env.ts', 'PROCESS_DOUBLE_NAME'],
      ['src/env.ts', 'BUN_DOT_NAME'],
      ['src/env.py', 'ENVIRON_GET_NAME'],
      ['src/env.py', 'ENVIRON_SINGLE_NAME'],
      ['src/env.py', 'GETENV_NAME'],
    ]) {
      expect(
        inputRules(`\`${path}:${name}\``, 'canon/reference-symbol', {
          trackedPaths: ['src/env.ts', 'src/env.py'],
          sourceTexts,
        }),
      ).toEqual([])
    }
  })

  test('code and symbol references accept an optional property declaration', () => {
    const extra = {
      trackedPaths: ['src/settings.ts'],
      sourceTexts: [
        { path: 'src/settings.ts', text: 'type Settings = { readonly_create?: string }' },
      ],
    }
    expect(inputRules('`settings.readonly_create`', 'canon/reference-code', extra)).toEqual([])
    expect(
      inputRules('`src/settings.ts:readonly_create`', 'canon/reference-symbol', extra),
    ).toEqual([])
  })

  test('symbol references accept a quoted dotted property declaration', () => {
    expect(
      inputRules('`src/settings.ts:ssh_alias`', 'canon/reference-symbol', {
        trackedPaths: ['src/settings.ts'],
        sourceTexts: [
          { path: 'src/settings.ts', text: "const fields = { 'model_host.ssh_alias': {} }" },
        ],
      }),
    ).toEqual([])
  })

  test('symbol references accept export-list declarations', () => {
    expect(
      inputRules('`src/settings.ts:publicName`', 'canon/reference-symbol', {
        trackedPaths: ['src/settings.ts'],
        sourceTexts: [{ path: 'src/settings.ts', text: 'export { privateName as publicName }' }],
      }),
    ).toEqual([])
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
  test('enforce is a context-only boolean that requires paths when enabled', () => {
    expect(
      canonFrontmatter('---\ndescription: Guarded\npaths: [src/**]\nenforce: true\n---\n'),
    ).toEqual(expect.objectContaining({ enforce: true, declaresEnforce: true }))
    expect(canonFrontmatter('---\ndescription: Guarded\npaths: []\nenforce: false\n---\n')).toEqual(
      expect.objectContaining({ enforce: false, declaresEnforce: true }),
    )
    expect(
      rules(
        [
          {
            path: '.agents/contexts/a.md',
            text: '---\ndescription: Guarded\npaths: []\nenforce: true\n---\n',
          },
        ],
        'canon/enforce',
      ),
    ).toEqual([expect.objectContaining({ message: 'enforce: true requires non-empty paths' })])
    expect(
      rules(
        [
          {
            path: '.agents/rules/a.md',
            text: '---\ndescription: A rule\nalways: true\nenforce: false\n---\n',
          },
        ],
        'canon/enforce',
      ),
    ).toEqual([expect.objectContaining({ message: 'enforce may be declared only by a context' })])
  })

  test('context path globs require a matching tracked file', () => {
    const files = [
      {
        path: '.agents/contexts/a.md',
        text: `---\ndescription: A context\npaths:\n  - orchestrator/src/**/judgment.ts\n---\n`,
      },
    ]
    expect(
      lint(files, { trackedPaths: ['orchestrator/src/judgment.ts'] }).findings.filter(
        (finding) => finding.rule === 'canon/context-path-glob',
      ),
    ).toEqual([])
    expect(
      lint(files, { trackedPaths: ['orchestrator/src/routing.ts'] }).findings.filter(
        (finding) => finding.rule === 'canon/context-path-glob',
      ),
    ).toEqual([
      expect.objectContaining({
        file: '.agents/contexts/a.md',
        message: expect.stringContaining('orchestrator/src/**/judgment.ts'),
      }),
    ])
  })

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
