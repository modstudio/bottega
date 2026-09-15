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
import { type CanonFile, lintCanon } from './canon-lint.ts'

const lint = (files: CanonFile[], taskKeyPrefixes: string[] = ['DEV']) =>
  lintCanon({ files, taskKeyPrefixes })
const rules = (files: CanonFile[], rule: string, prefixes?: string[]) =>
  lint(files, prefixes).findings.filter((finding) => finding.rule === rule)
const text = (bytes: number) => 'x'.repeat(bytes)
const card = (extra = '') =>
  `## Purpose\n\nP\n\n## Belongs here\n\nB\n\n## Does not belong here\n\nD\n\n## May depend on\n\nM\n${extra}`
const ruleDoc = (body = 'Current rule.') => `---\ndescription: A rule\n---\n${body}\n`
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

  test('issue reports prose and task keys in inline code but ignores other code spans', () => {
    const result = rules(
      [
        {
          path: 'AGENTS.md',
          text: 'Known issue here.\n`workaround`\n`DEV-572`\n```\nDEV-573 known issue\n```\n',
        },
      ],
      'canon/issue',
    )
    expect(result.map((finding) => finding.line)).toEqual([1, 3])
    expect(rules([{ path: 'AGENTS.md', text: 'Current rule.' }], 'canon/issue')).toEqual([])
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
