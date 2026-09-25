// concern: canon-lint
/** Knows pure canon classification and lint rules. Must not know filesystems, stores, commands, or processes. */
import { posix } from 'node:path'
import GithubSlugger from 'github-slugger'
import { CANON_REFERENCE_EXEMPTIONS } from '../../../shared/canon-references.ts'
import { type Finding, introducedFindings } from '../../../shared/ratchet.ts'
import {
  ALWAYS_ON_TOTAL_BYTES,
  CARD_BYTES,
  CHAIN_BYTES,
  CONTEXT_BYTES,
  ENTRY_BYTES,
  REFERENCE_BYTES,
  RULE_BYTES,
} from './canon-budget.ts'
import { lintProse, proseLines } from './prose-lint.ts'

export type CanonFile = { path: string; text: string; symlinkTarget?: string }
export type CanonSourceText = { path: string; text: string }
export type CanonLintInput = {
  files: CanonFile[]
  /** Markdown bodies that participate only as repository-reference citers. */
  referenceFiles?: CanonFile[]
  trackedPaths: string[]
  packageScripts: string[]
  sourceTexts: CanonSourceText[]
}
export type CanonFinding = Finding & { measuredBytes?: number }

export function isCanonCodeSourcePath(path: string): boolean {
  return /\.(?:ts|tsx|js|mjs|cjs|py|sh|php|vue)$/.test(path)
}

type CanonMeasurement = { path: string; bytes: number; limit: number }
type CanonLintSummary = {
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
export type CanonLintResult = { summary: CanonLintSummary; findings: CanonFinding[] }

const REFERENCE_EXEMPTIONS: { reference: string; reason: string }[] =
  CANON_REFERENCE_EXEMPTIONS.map(({ path, reason }) => ({ reference: path, reason }))

export type CanonKind =
  | 'entry'
  | 'rule'
  | 'context'
  | 'reference'
  | 'card'
  | 'alias'
  | 'publication'

function resolvedTarget(file: CanonFile): string | null {
  if (file.symlinkTarget === undefined) return null
  if (posix.isAbsolute(file.symlinkTarget)) return posix.normalize(file.symlinkTarget)
  return posix.normalize(posix.join(posix.dirname(file.path), file.symlinkTarget))
}

export function classifyCanonFile(file: CanonFile): CanonKind | null {
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

function sizeFinding(file: CanonFile, rule: string, measured: number, limit: number): CanonFinding {
  return {
    file: file.path,
    line: 1,
    rule,
    message: `measured ${measured} bytes; limit ${limit} bytes`,
    measuredBytes: measured,
  }
}

function measured(file: CanonFile, limit: number): CanonMeasurement {
  return { path: file.path, bytes: bytes(file), limit }
}

export function canonFrontmatter(text: string): {
  description: string | null
  paths: string[]
  declaresPaths: boolean
  always: boolean | null
  declaresAlways: boolean
} | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return null
  const yaml = match[1]!
  const description = yaml.match(/^description:\s*(.*?)\s*$/m)?.[1] ?? null
  const cleanDescription = description?.replace(/^(['"])(.*)\1$/, '$2').trim()
  const validDescription =
    cleanDescription && !['null', '~', '[]', '{}'].includes(cleanDescription)
      ? cleanDescription
      : null
  const alwaysValue = yaml.match(/^always:\s*(.*?)\s*$/m)?.[1]
  const declaresAlways = alwaysValue !== undefined
  const always = alwaysValue === 'true' ? true : alwaysValue === 'false' ? false : null
  const inlinePaths = yaml.match(/^paths:\s*\[(.*?)\]\s*$/m)?.[1]
  if (inlinePaths !== undefined) {
    return {
      description: validDescription,
      declaresPaths: true,
      always,
      declaresAlways,
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
  return {
    description: validDescription,
    paths,
    declaresPaths: pathsAt >= 0,
    always,
    declaresAlways,
  }
}

function proseFindings(file: CanonFile, findings: CanonFinding[]): void {
  findings.push(
    ...lintProse(file.text).map(({ line, rule, message }) => ({
      file: file.path,
      line,
      rule: `canon/${rule}`,
      message,
    })),
  )
}

type LineSpan = { content: string; line: number }

function scannedLines(file: CanonFile): { text: string; line: number }[] {
  return proseLines(file.text)
}

function inlineCodeSpans(file: CanonFile): LineSpan[] {
  return scannedLines(file).flatMap(({ text, line }) =>
    [...text.matchAll(/(`+)([^`\n]*?)\1/g)].map((match) => ({ content: match[2]!, line })),
  )
}

function markdownLinkTargets(file: CanonFile): LineSpan[] {
  return scannedLines(file).flatMap(({ text, line }) =>
    [...text.matchAll(/\[[^\]]*\]\(\s*([^\s)]+)(?:\s+[^)]*)?\)/g)].map((match) => ({
      content: match[1]!,
      line,
    })),
  )
}

function headingReference(target: string): { path: string; fragment: string } | null {
  const hash = target.indexOf('#')
  if (hash < 0) return null
  const path = target.slice(0, hash)
  const fragment = target.slice(hash + 1)
  if (!fragment || (path && !path.endsWith('.md'))) return null
  return { path, fragment }
}

function referencePieces(file: CanonFile): LineSpan[] {
  return [...inlineCodeSpans(file), ...markdownLinkTargets(file)].flatMap(({ content, line }) =>
    content
      .split(/\s+/)
      .filter(Boolean)
      .map((piece) => ({ content: piece, line })),
  )
}

function headingReferencePieces(file: CanonFile): LineSpan[] {
  const pieces = (spans: LineSpan[]) =>
    spans.flatMap(({ content, line }) =>
      content
        .split(/\s+/)
        .filter(Boolean)
        .map((piece) => ({ content: piece, line })),
    )
  return [
    ...pieces(inlineCodeSpans(file)).filter(({ content }) =>
      Boolean(headingReference(content)?.path),
    ),
    ...pieces(markdownLinkTargets(file)),
  ]
}

function stripReferenceSuffix(reference: string): string {
  return reference.replace(/:(?:[A-Za-z_$][\w$]*|\d+(?:-\d+)?)$/, '')
}

function globStar(pattern: string, index: number): { source: string; index: number } {
  if (pattern[index + 1] !== '*') return { source: '[^/]*', index }
  if (pattern[index + 2] === '/') return { source: '(?:.*/)?', index: index + 2 }
  return { source: '.*', index: index + 1 }
}

function globPattern(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!
    if (character === '*') {
      const glob = globStar(pattern, index)
      source += glob.source
      index = glob.index
    } else if (character === '?') source += '[^/]'
    else if (character === '[') {
      const end = pattern.indexOf(']', index + 1)
      if (end < 0) source += '\\['
      else {
        source += pattern.slice(index, end + 1)
        index = end
      }
    } else source += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  }
  return new RegExp(`${source}$`)
}

/** URLs, home- or variable-rooted paths and placeholders never name a tracked path. */
function isNonRepositoryShape(reference: string): boolean {
  if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(reference) || reference.startsWith('mailto:')) return true
  return /^[~/$-]/.test(reference) || /[<>{}]/.test(reference)
}

function isRepositoryCandidate(reference: string, firstSegments: Set<string>): boolean {
  return firstSegments.has(reference.split('/')[0]!)
}

const FILE_REFERENCE = /\.(?:ts|tsx|js|mjs|cjs|py|sh|php|vue|json|jsonc|md|toml|yml|yaml|sql)$/

function pathMatches(reference: string, trackedPath: string): boolean {
  if (/[*?[\]]/.test(reference)) return globPattern(reference).test(trackedPath)
  return trackedPath === reference || trackedPath.startsWith(`${reference}/`)
}

function resolvedReferencePaths(
  reference: string,
  canonPath: string,
  trackedPaths: string[],
): string[] {
  const exemptions = new Set(REFERENCE_EXEMPTIONS.map(({ reference: item }) => item))
  if (exemptions.has(reference)) return [reference]

  const matched = new Set<string>()
  const addMatches = (candidate: string) => {
    for (const trackedPath of trackedPaths) {
      if (pathMatches(candidate, trackedPath)) matched.add(trackedPath)
    }
  }
  addMatches(reference)
  addMatches(posix.normalize(posix.join(posix.dirname(canonPath), reference)))

  const suffix = `/${reference}`
  for (const trackedPath of trackedPaths) {
    if (
      /[*?[\]]/.test(reference)
        ? globPattern(`**${suffix}`).test(trackedPath)
        : trackedPath.endsWith(suffix)
    ) {
      matched.add(trackedPath)
    }
  }
  return [...matched]
}

const DECLARATION_PATTERNS = [
  /\b(?:function|func|const|let|var|class|interface|type|enum|def)\s+([A-Za-z_$][\w$]*)\b/g,
  /\b([A-Za-z_$][\w$]*)\b\s*[=:]/g,
  /\b([A-Za-z_$][\w$]*)\b\s*\?\s*:/g,
  /['"][^'"\r\n]*\.([A-Za-z_$][\w$]*)['"]\s*:/g,
  /(?:\b(?:public|private|protected|static|abstract|async|get|set)\s+)*\b([A-Za-z_$][\w$]*)\b\s*\([^)]*\)\s*(?:\{|=>|:)/g,
  /\b(?:process|Bun)\.env\.([A-Z][A-Z0-9_]*)\b/g,
  /\bos\.environ\.get\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g,
  /\bos\.getenv\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g,
] as const

function addExportedIdentifiers(line: string, identifiers: Set<string>): void {
  for (const exported of line.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const item of exported[1]!.split(',')) {
      const name = item
        .trim()
        .replace(/^type\s+/, '')
        .match(/^(?:[A-Za-z_$][\w$]*\s+as\s+)?([A-Za-z_$][\w$]*)$/)?.[1]
      if (name) identifiers.add(name)
    }
  }
}

function addLineDeclarations(line: string, identifiers: Set<string>): void {
  for (const pattern of DECLARATION_PATTERNS) {
    for (const match of line.matchAll(pattern)) identifiers.add(match[1]!)
  }
  for (const match of line.matchAll(
    /\b(?:process\.env|os\.environ)\[\s*(['"])([A-Z][A-Z0-9_]*)\1\s*\]/g,
  )) {
    identifiers.add(match[2]!)
  }
  addExportedIdentifiers(line, identifiers)
}

function uncommentedSourceLines(text: string): string[] {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
  return withoutBlockComments.split(/\r?\n/).filter((line) => !/^\s*(?:\/\/|--|#(?!\[))/.test(line))
}

function declaredIdentifiers(text: string): Set<string> {
  const identifiers = new Set<string>()
  for (const line of uncommentedSourceLines(text)) addLineDeclarations(line, identifiers)
  return identifiers
}

function escapedIdentifier(identifier: string): string {
  return identifier.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

function headingLabels(text: string): string[] {
  const slugger = new GithubSlugger()
  const lines = proseLines(text)
  const labels: string[] = []
  for (const [index, line] of lines.entries()) {
    const atx = line.text.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1]
    const next = lines[index + 1]
    const setext =
      next?.line === line.line + 1 && /^ {0,3}(?:=+|-+)\s*$/.test(next.text)
        ? line.text.trim()
        : null
    const heading = atx ?? setext
    if (!heading) continue
    const visible = heading
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/[`*_~]/g, '')
    labels.push(slugger.slug(visible))
  }
  return labels
}

type ReferenceFacts = {
  declarations: Map<string, Set<string>>
  headings: Map<string, string[]>
  occurrenceCorpus: string
}

function referenceFacts(input: CanonLintInput): ReferenceFacts {
  const texts = new Map<string, string>()
  for (const { path, text } of [...input.sourceTexts, ...input.files]) texts.set(path, text)
  return {
    declarations: new Map([...texts].map(([path, text]) => [path, declaredIdentifiers(text)])),
    headings: new Map([...texts].map(([path, text]) => [path, headingLabels(text)])),
    occurrenceCorpus: productionOccurrenceCorpus(input.sourceTexts),
  }
}

function referenceHeadingFindings(
  file: CanonFile,
  input: CanonLintInput,
  facts: ReferenceFacts,
): CanonFinding[] {
  return headingReferencePieces(file).flatMap(({ content, line }) => {
    const reference = headingReference(content)
    if (!reference) return []
    const matchedPaths = reference.path
      ? resolvedReferencePaths(reference.path, file.path, input.trackedPaths)
      : [file.path]
    if (!matchedPaths.length) return []
    if (matchedPaths.some((path) => facts.headings.get(path)?.includes(reference.fragment))) {
      return []
    }
    return [
      {
        file: file.path,
        line,
        rule: 'canon/reference-heading',
        message: `Markdown heading ${content} does not resolve`,
      },
    ]
  })
}

function referenceFindings(
  file: CanonFile,
  input: CanonLintInput,
  facts: ReferenceFacts,
): CanonFinding[] {
  const findings: CanonFinding[] = []
  const firstSegments = new Set(input.trackedPaths.map((path) => path.split('/')[0]!))
  for (const { content: candidate, line } of referencePieces(file)) {
    const withoutHeading = headingReference(candidate)?.path ?? candidate
    if (!withoutHeading) continue
    const unsuffixedPath = stripReferenceSuffix(withoutHeading)
    const path = unsuffixedPath.replace(/\/$/, '')
    if (
      isNonRepositoryShape(path) ||
      (!FILE_REFERENCE.test(path) && !isRepositoryCandidate(path, firstSegments))
    )
      continue
    const matchedPaths = resolvedReferencePaths(path, file.path, input.trackedPaths)
    if (!matchedPaths.length) {
      findings.push({
        file: file.path,
        line,
        rule: 'canon/reference-path',
        message: `repository path ${path} is not tracked`,
      })
      continue
    }
    const anchor = candidate.slice(unsuffixedPath.length)
    if (/^:\d+(?:-\d+)?$/.test(anchor)) {
      findings.push({
        file: file.path,
        line,
        rule: 'canon/line-anchor',
        message: `line anchor ${candidate} rots; cite an identifier`,
      })
      continue
    }
    const identifier = anchor.match(/^:([A-Za-z_$][\w$]*)$/)?.[1]
    if (
      identifier &&
      !matchedPaths.some((matched) => facts.declarations.get(matched)?.has(identifier))
    ) {
      findings.push({
        file: file.path,
        line,
        rule: 'canon/reference-symbol',
        message: `${matchedPaths.join(', ')} do not declare identifier ${identifier}`,
      })
    }
  }
  return findings
}

function productionSourceTexts(sourceTexts: CanonSourceText[]): CanonSourceText[] {
  return sourceTexts.filter(
    ({ path }) =>
      isCanonCodeSourcePath(path) &&
      !/\.(?:test|spec)\.[^/]+$/.test(path) &&
      !/(?:^|\/)(?:test|fixtures)\//.test(path),
  )
}

function productionOccurrenceCorpus(sourceTexts: CanonSourceText[]): string {
  return productionSourceTexts(sourceTexts)
    .flatMap(({ text }) => uncommentedSourceLines(text))
    .join('\n')
}

function referenceCodeFindings(file: CanonFile, source: string): CanonFinding[] {
  return inlineCodeSpans(file).flatMap(({ content, line }) => {
    if (FILE_REFERENCE.test(content)) return []
    const match = content.match(
      /^(?:([A-Za-z_$][\w$]*)\(\)|[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)(?:\(\))?|([A-Z][A-Z0-9_]*_[A-Z0-9_]*))$/,
    )
    const identifier = match?.[1] ?? match?.[2] ?? match?.[3]
    if (
      !identifier ||
      (match?.[3] && content.length < 4) ||
      new RegExp(`\\b${escapedIdentifier(identifier)}\\b`).test(source)
    )
      return []
    return [
      {
        file: file.path,
        line,
        rule: 'canon/reference-code',
        message: `identifier ${identifier} does not occur in tracked production source`,
      },
    ]
  })
}

function referenceScriptFindings(file: CanonFile, packageScripts: string[]): CanonFinding[] {
  const scripts = new Set(packageScripts)
  return file.text.split(/\r?\n/).flatMap((lineText, index) =>
    [...lineText.matchAll(/\b(?:bun|npm) run ([a-z][\w:.-]*)(?![\w:.$/-])/g)].flatMap((match) => {
      const name = match[1]!
      if (
        name.includes('$') ||
        name.includes('/') ||
        /\.(?:ts|js)$/.test(name) ||
        scripts.has(name)
      ) {
        return []
      }
      return [
        {
          file: file.path,
          line: index + 1,
          rule: 'canon/reference-script',
          message: `package script ${name} is not defined`,
        },
      ]
    }),
  )
}

function lintCanonReferencesWithFacts(
  file: CanonFile,
  input: CanonLintInput,
  facts: ReferenceFacts,
): CanonFinding[] {
  return [
    ...referenceFindings(file, input, facts),
    ...referenceHeadingFindings(file, input, facts),
    ...referenceCodeFindings(file, facts.occurrenceCorpus),
    ...referenceScriptFindings(file, input.packageScripts),
  ]
}

/** Runs the pure repository-reference rules against any markdown body. */
export function lintCanonReferences(file: CanonFile, input: CanonLintInput): CanonFinding[] {
  return lintCanonReferencesWithFacts(file, input, referenceFacts(input))
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

type Classified = { file: CanonFile; kind: CanonKind | null }
type TierFiles = {
  entries: CanonFile[]
  rules: CanonFile[]
  contexts: CanonFile[]
  references: CanonFile[]
  cards: CanonFile[]
}

function tierFiles(classified: Classified[]): TierFiles {
  return {
    entries: classified.filter(({ kind }) => kind === 'entry').map(({ file }) => file),
    rules: classified.filter(({ kind }) => kind === 'rule').map(({ file }) => file),
    contexts: classified.filter(({ kind }) => kind === 'context').map(({ file }) => file),
    references: classified.filter(({ kind }) => kind === 'reference').map(({ file }) => file),
    cards: classified.filter(({ kind }) => kind === 'card').map(({ file }) => file),
  }
}

function tierSummary(tiers: TierFiles): CanonLintSummary['tiers'] {
  return {
    entry: tiers.entries[0] ? measured(tiers.entries[0], ENTRY_BYTES) : null,
    alwaysOn: {
      bytes:
        tiers.entries.reduce((total, file) => total + bytes(file), 0) +
        tiers.rules.reduce((total, file) => total + bytes(file), 0),
      limit: ALWAYS_ON_TOTAL_BYTES,
    },
    rules: tiers.rules.map((file) => measured(file, RULE_BYTES)),
    contexts: tiers.contexts.map((file) => measured(file, CONTEXT_BYTES)),
    references: tiers.references.map((file) => measured(file, REFERENCE_BYTES)),
    cards: tiers.cards.map((file) => measured(file, CARD_BYTES)),
  }
}

function sizeFindings(tiers: TierFiles, summary: CanonLintSummary['tiers']): CanonFinding[] {
  const findings: CanonFinding[] = []
  for (const entry of tiers.entries) {
    if (bytes(entry) > ENTRY_BYTES) {
      findings.push(sizeFinding(entry, 'canon/size-entry', bytes(entry), ENTRY_BYTES))
    }
  }
  if (summary.alwaysOn.bytes > ALWAYS_ON_TOTAL_BYTES) {
    findings.push({
      file: tiers.entries[0]?.path ?? tiers.rules[0]?.path ?? 'AGENTS.md',
      line: 1,
      rule: 'canon/size-always-on',
      message: `measured ${summary.alwaysOn.bytes} bytes; limit ${ALWAYS_ON_TOTAL_BYTES} bytes`,
      measuredBytes: summary.alwaysOn.bytes,
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
  findings: CanonFinding[]
} {
  const findings: CanonFinding[] = []
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
  const metadata = canonFrontmatter(file.text)
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

function tierDeclarationFinding(file: CanonFile, kind: 'rule' | 'context'): Finding[] {
  const metadata = canonFrontmatter(file.text)
  const valid =
    kind === 'rule'
      ? metadata?.always === true && !metadata.declaresPaths
      : metadata?.declaresPaths === true && !metadata.declaresAlways
  if (valid) return []
  return [
    {
      file: file.path,
      line: 1,
      rule: 'canon/tier-declaration',
      message:
        kind === 'rule'
          ? 'rule files require always: true and must not declare paths'
          : 'context files require paths and must not declare always',
    },
  ]
}

function contextPathFindings(file: CanonFile, trackedPaths: string[]): Finding[] {
  const metadata = canonFrontmatter(file.text)
  if (!metadata) return []
  return metadata.paths.flatMap((pattern) =>
    trackedPaths.some((path) => globPattern(pattern).test(path))
      ? []
      : [
          {
            file: file.path,
            line: 1,
            rule: 'canon/context-path-glob',
            message: `context ${file.path} path glob ${JSON.stringify(pattern)} matches no tracked file; correct the glob in the canon store with orch doc set, then orch canon hydrate`,
          },
        ],
  )
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

function contentFindings(
  classified: Classified,
  input: CanonLintInput,
  facts: ReferenceFacts,
): CanonFinding[] {
  const { file, kind } = classified
  if (!kind || kind === 'alias' || kind === 'publication') return []
  const findings: CanonFinding[] = []
  proseFindings(file, findings)
  findings.push(...lintCanonReferencesWithFacts(file, input, facts))
  if (kind === 'rule' || kind === 'context' || kind === 'reference') {
    findings.push(...frontmatterFinding(file, kind))
  }
  if (kind === 'rule' || kind === 'context') {
    findings.push(...tierDeclarationFinding(file, kind))
  }
  if (kind === 'context') findings.push(...contextPathFindings(file, input.trackedPaths))
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

export function lintCanon(input: CanonLintInput): CanonLintResult {
  const classified = input.files.map(
    (file): Classified => ({ file, kind: classifyCanonFile(file) }),
  )
  const tiers = tierFiles(classified)
  const tierMeasurements = tierSummary(tiers)
  const chains = chainMeasurements(classified)
  const paths = new Set(input.files.map((file) => file.path))
  const facts = referenceFacts(input)
  const findings = [
    ...sizeFindings(tiers, tierMeasurements),
    ...chains.findings,
    ...classified.flatMap((item) => contentFindings(item, input, facts)),
    ...(input.referenceFiles ?? []).flatMap((file) =>
      lintCanonReferencesWithFacts(file, input, facts),
    ),
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

function isSizeFinding(finding: CanonFinding): boolean {
  return finding.rule.startsWith('canon/size-')
}

export function introducedCanonFindings(
  baseline: CanonFinding[],
  findings: CanonFinding[],
): CanonFinding[] {
  const introduced = introducedFindings(
    baseline.filter((finding) => !isSizeFinding(finding)),
    findings.filter((finding) => !isSizeFinding(finding)),
  )
  for (const finding of findings.filter(isSizeFinding)) {
    const previousMeasured = baseline.find(
      (candidate) =>
        candidate.file === finding.file &&
        candidate.rule === finding.rule &&
        candidate.measuredBytes !== undefined,
    )?.measuredBytes
    if (
      finding.measuredBytes === undefined ||
      previousMeasured === undefined ||
      finding.measuredBytes > previousMeasured
    ) {
      introduced.push(finding)
    }
  }
  return introduced
}
