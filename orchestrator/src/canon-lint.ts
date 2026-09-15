// concern: canon-lint
/** Knows pure canon classification and lint rules. Must not know filesystems, stores, commands, or processes. */
import { posix } from 'node:path'
import type { Finding } from '../../shared/ratchet.ts'
import {
  ALWAYS_ON_TOTAL_BYTES,
  CARD_BYTES,
  CHAIN_BYTES,
  CONTEXT_BYTES,
  ENTRY_BYTES,
  REFERENCE_BYTES,
  RULE_BYTES,
} from './canon-budget.ts'

export type CanonFile = { path: string; text: string; symlinkTarget?: string }

export type CanonMeasurement = { path: string; bytes: number; limit: number }
export type CanonLintSummary = {
  tiers: {
    entry: CanonMeasurement | null
    alwaysOn: { bytes: number; limit: number }
    rules: CanonMeasurement[]
    contexts: CanonMeasurement[]
    references: CanonMeasurement[]
    cards: CanonMeasurement[]
  }
  chains: CanonMeasurement[]
}
export type CanonLintResult = { summary: CanonLintSummary; findings: Finding[] }

export const HISTORY_PATTERNS = [
  /\bused to\b/i,
  /\bwas (?:called|named)\b/i,
  /\brenamed\b/i,
  /\bno longer\b/i,
  /\bpreviously\b/i,
  /\bformerly\b/i,
  /\b(?:that|this|it) (?:has )?changed\b/i,
  /\b20\d\d-\d\d-\d\d\b/i,
]

export const ISSUE_PATTERNS = [
  /\bworkaround\b/i,
  /\bknown issue\b/i,
  /\buntil (?:it is |this is )?fixed\b/i,
  /\bTODO\b/i,
  /\bFIXME\b/i,
]

type Kind = 'entry' | 'rule' | 'context' | 'reference' | 'card' | 'alias' | 'publication'

function resolvedTarget(file: CanonFile): string | null {
  if (file.symlinkTarget === undefined) return null
  if (posix.isAbsolute(file.symlinkTarget)) return posix.normalize(file.symlinkTarget)
  return posix.normalize(posix.join(posix.dirname(file.path), file.symlinkTarget))
}

function kindOf(file: CanonFile): Kind | null {
  if (file.path === 'AGENTS.md') return 'entry'
  if (/^\.agents\/rules\/[^/]+\.md$/.test(file.path)) return 'rule'
  if (/^\.agents\/contexts\/[^/]+\.md$/.test(file.path)) return 'context'
  if (/^\.agents\/reference\/[^/]+\.md$/.test(file.path)) return 'reference'
  if (posix.basename(file.path) === 'CLAUDE.md') return 'alias'
  if (posix.basename(file.path) !== 'AGENTS.md') return null
  return resolvedTarget(file)?.startsWith('.agents/contexts/') ? 'publication' : 'card'
}

function bytes(file: CanonFile): number {
  return Buffer.byteLength(file.text, 'utf8')
}

function sizeFinding(file: CanonFile, rule: string, measured: number, limit: number): Finding {
  return {
    file: file.path,
    line: 1,
    rule,
    message: `measured ${measured} bytes; limit ${limit} bytes`,
  }
}

function measured(file: CanonFile, limit: number): CanonMeasurement {
  return { path: file.path, bytes: bytes(file), limit }
}

function frontmatter(text: string): { description: string | null; paths: string[] } | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return null
  const yaml = match[1]!
  const description = yaml.match(/^description:\s*(.*?)\s*$/m)?.[1] ?? null
  const cleanDescription = description?.replace(/^(['"])(.*)\1$/, '$2').trim()
  const validDescription =
    cleanDescription && !['null', '~', '[]', '{}'].includes(cleanDescription)
      ? cleanDescription
      : null
  const inlinePaths = yaml.match(/^paths:\s*\[(.*?)\]\s*$/m)?.[1]
  if (inlinePaths !== undefined) {
    return {
      description: validDescription,
      paths: inlinePaths
        .split(',')
        .map((value) => value.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean),
    }
  }
  const lines = yaml.split(/\r?\n/)
  const pathsAt = lines.findIndex((line) => /^paths:\s*$/.test(line))
  const paths: string[] = []
  if (pathsAt >= 0) {
    for (const line of lines.slice(pathsAt + 1)) {
      const item = line.match(/^\s+-\s+(.+?)\s*$/)?.[1]
      if (!item) break
      paths.push(item.replace(/^['"]|['"]$/g, ''))
    }
  }
  return { description: validDescription, paths }
}

function proseFindings(file: CanonFile, taskKeyPattern: RegExp | null, findings: Finding[]): void {
  let fence: '`' | '~' | null = null
  for (const [index, line] of file.text.split(/\r?\n/).entries()) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1]?.[0] as '`' | '~' | undefined
    if (marker) {
      if (fence === marker) fence = null
      else if (fence === null) fence = marker
      continue
    }
    if (fence !== null) continue
    const withoutInlineCode = line.replace(/(`+)[^`]*?\1/g, '')
    const historyPattern = HISTORY_PATTERNS.find((pattern) => pattern.test(withoutInlineCode))
    if (historyPattern) {
      findings.push({
        file: file.path,
        line: index + 1,
        rule: 'canon/history',
        message: `matches banned history pattern ${historyPattern.source}`,
      })
    }
    const issuePattern = ISSUE_PATTERNS.find((pattern) => pattern.test(withoutInlineCode))
    if (taskKeyPattern?.test(line)) {
      findings.push({
        file: file.path,
        line: index + 1,
        rule: 'canon/issue',
        message: 'contains a task key',
      })
    } else if (issuePattern) {
      findings.push({
        file: file.path,
        line: index + 1,
        rule: 'canon/issue',
        message: `matches banned issue pattern ${issuePattern.source}`,
      })
    }
  }
}

function taskPattern(prefixes: string[]): RegExp | null {
  const escaped = [...new Set(prefixes.filter(Boolean))].map((prefix) =>
    prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  )
  return escaped.length ? new RegExp(`\\b(?:${escaped.join('|')})-\\d+\\b`, 'i') : null
}

function chainFiles(path: string, agentsByPath: Map<string, CanonFile>): CanonFile[] {
  const directory = posix.dirname(path)
  const parts = directory === '.' ? [] : directory.split('/')
  const paths = ['AGENTS.md']
  for (let index = 1; index <= parts.length; index++) {
    paths.push(`${parts.slice(0, index).join('/')}/AGENTS.md`)
  }
  return paths.flatMap((candidate) => {
    const file = agentsByPath.get(candidate)
    return file ? [file] : []
  })
}

type Classified = { file: CanonFile; kind: Kind | null }
type TierFiles = {
  entry: CanonFile | null
  rules: CanonFile[]
  contexts: CanonFile[]
  references: CanonFile[]
  cards: CanonFile[]
}

function tierFiles(classified: Classified[]): TierFiles {
  return {
    entry: classified.find(({ kind }) => kind === 'entry')?.file ?? null,
    rules: classified.filter(({ kind }) => kind === 'rule').map(({ file }) => file),
    contexts: classified.filter(({ kind }) => kind === 'context').map(({ file }) => file),
    references: classified.filter(({ kind }) => kind === 'reference').map(({ file }) => file),
    cards: classified.filter(({ kind }) => kind === 'card').map(({ file }) => file),
  }
}

function tierSummary(tiers: TierFiles): CanonLintSummary['tiers'] {
  return {
    entry: tiers.entry ? measured(tiers.entry, ENTRY_BYTES) : null,
    alwaysOn: {
      bytes:
        (tiers.entry ? bytes(tiers.entry) : 0) +
        tiers.rules.reduce((total, file) => total + bytes(file), 0),
      limit: ALWAYS_ON_TOTAL_BYTES,
    },
    rules: tiers.rules.map((file) => measured(file, RULE_BYTES)),
    contexts: tiers.contexts.map((file) => measured(file, CONTEXT_BYTES)),
    references: tiers.references.map((file) => measured(file, REFERENCE_BYTES)),
    cards: tiers.cards.map((file) => measured(file, CARD_BYTES)),
  }
}

function sizeFindings(tiers: TierFiles, summary: CanonLintSummary['tiers']): Finding[] {
  const findings: Finding[] = []
  if (tiers.entry && bytes(tiers.entry) > ENTRY_BYTES) {
    findings.push(sizeFinding(tiers.entry, 'canon/size-entry', bytes(tiers.entry), ENTRY_BYTES))
  }
  if (summary.alwaysOn.bytes > ALWAYS_ON_TOTAL_BYTES) {
    findings.push({
      file: tiers.entry?.path ?? tiers.rules[0]?.path ?? 'AGENTS.md',
      line: 1,
      rule: 'canon/size-always-on',
      message: `measured ${summary.alwaysOn.bytes} bytes; limit ${ALWAYS_ON_TOTAL_BYTES} bytes`,
    })
  }
  for (const [files, rule, limit] of [
    [tiers.rules, 'canon/size-rule', RULE_BYTES],
    [tiers.contexts, 'canon/size-context', CONTEXT_BYTES],
    [tiers.references, 'canon/size-reference', REFERENCE_BYTES],
    [tiers.cards, 'canon/size-card', CARD_BYTES],
  ] as const) {
    for (const file of files) {
      if (bytes(file) > limit) findings.push(sizeFinding(file, rule, bytes(file), limit))
    }
  }
  return findings
}

function chainMeasurements(classified: Classified[]): {
  measurements: CanonMeasurement[]
  findings: Finding[]
} {
  const findings: Finding[] = []
  const measurements: CanonMeasurement[] = []
  const agentsByPath = new Map(
    classified
      .filter(({ file }) => posix.basename(file.path) === 'AGENTS.md')
      .map(({ file }) => [file.path, file] as const),
  )
  for (const file of [...agentsByPath.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const chainBytes = chainFiles(file.path, agentsByPath).reduce(
      (total, item) => total + bytes(item),
      0,
    )
    measurements.push({ path: file.path, bytes: chainBytes, limit: CHAIN_BYTES })
    if (chainBytes > CHAIN_BYTES) {
      findings.push(sizeFinding(file, 'canon/size-chain', chainBytes, CHAIN_BYTES))
    }
  }
  return { measurements, findings }
}

function frontmatterFinding(file: CanonFile, kind: 'rule' | 'context' | 'reference'): Finding[] {
  const metadata = frontmatter(file.text)
  if (metadata?.description && (kind !== 'context' || metadata.paths.length > 0)) return []
  return [
    {
      file: file.path,
      line: 1,
      rule: 'canon/frontmatter',
      message:
        kind === 'context'
          ? 'requires YAML frontmatter with non-empty description and paths'
          : 'requires YAML frontmatter with non-empty description',
    },
  ]
}

function cardHeadingFindings(file: CanonFile): Finding[] {
  const required = ['## Purpose', '## Belongs here', '## Does not belong here', '## May depend on']
  const lines = file.text.split(/\r?\n/)
  const missing = required.filter((heading) => !lines.some((line) => line.trimEnd() === heading))
  return missing.length
    ? [
        {
          file: file.path,
          line: 1,
          rule: 'canon/card-headings',
          message: `missing ${missing.join(', ')}`,
        },
      ]
    : []
}

function contentFindings(classified: Classified, taskKeyPattern: RegExp | null): Finding[] {
  const { file, kind } = classified
  if (!kind || kind === 'alias' || kind === 'publication') return []
  const findings: Finding[] = []
  proseFindings(file, taskKeyPattern, findings)
  if (kind === 'rule' || kind === 'context' || kind === 'reference') {
    findings.push(...frontmatterFinding(file, kind))
  }
  if (kind === 'card') findings.push(...cardHeadingFindings(file))
  return findings
}

function symlinkFindings(file: CanonFile, paths: Set<string>): Finding[] {
  const findings: Finding[] = []
  const target = resolvedTarget(file)
  if (posix.basename(file.path) === 'CLAUDE.md') {
    const expected = posix.join(posix.dirname(file.path), 'AGENTS.md')
    if (target !== expected) {
      findings.push({
        file: file.path,
        line: 1,
        rule: 'canon/symlink',
        message: 'CLAUDE.md must be a symlink to the sibling AGENTS.md',
      })
    }
  }
  if (target !== null && !paths.has(target)) {
    findings.push({
      file: file.path,
      line: 1,
      rule: 'canon/symlink',
      message: `symlink target ${file.symlinkTarget} does not exist`,
    })
  }
  return findings
}

export function lintCanon(input: {
  files: CanonFile[]
  taskKeyPrefixes: string[]
}): CanonLintResult {
  const classified = input.files.map((file): Classified => ({ file, kind: kindOf(file) }))
  const tiers = tierFiles(classified)
  const tierMeasurements = tierSummary(tiers)
  const chains = chainMeasurements(classified)
  const taskKeyPattern = taskPattern(input.taskKeyPrefixes)
  const paths = new Set(input.files.map((file) => file.path))
  const findings = [
    ...sizeFindings(tiers, tierMeasurements),
    ...chains.findings,
    ...classified.flatMap((file) => contentFindings(file, taskKeyPattern)),
    ...input.files.flatMap((file) => symlinkFindings(file, paths)),
  ]
  findings.sort(
    (a, b) =>
      a.rule.localeCompare(b.rule) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.message.localeCompare(b.message),
  )
  return {
    summary: { tiers: tierMeasurements, chains: chains.measurements },
    findings,
  }
}
