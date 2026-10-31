import { createHash } from 'node:crypto'
import type { ChangeFacts, Finding } from '../../shared/ratchet'

const KNIP_ISSUE_TYPES = [
  'files',
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
  'unlisted',
  'unresolved',
  'exports',
  'nsExports',
  'types',
  'nsTypes',
  'enumMembers',
  'namespaceMembers',
] as const

const DEAD_CODE_ISSUE_TYPES = [...KNIP_ISSUE_TYPES, 'unneededExports', 'unneededTypes'] as const

type KnipIssueType = (typeof KNIP_ISSUE_TYPES)[number]
type DeadCodeIssueType = (typeof DEAD_CODE_ISSUE_TYPES)[number]
export type DeadCodeFinding = {
  workspace: string
  file: string
  issueType: DeadCodeIssueType
  symbol: string
  line?: number
}

type KnipItem = { name: string; line?: number }
type KnipReport = {
  issues: Array<{ file: string } & Partial<Record<KnipIssueType, KnipItem[]>>>
}

function workspaceFor(file: string) {
  if (file.startsWith('hub/web/')) return 'hub/web'
  if (file.startsWith('orchestrator/')) return 'orchestrator'
  if (file.startsWith('hub/')) return 'hub'
  if (file.startsWith('retrieval/')) return 'retrieval'
  return '.'
}

export function normalizeKnipReport(
  report: KnipReport,
  issueTypes: readonly KnipIssueType[] = KNIP_ISSUE_TYPES,
): DeadCodeFinding[] {
  const findings = report.issues.flatMap((entry) =>
    issueTypes.flatMap((issueType) =>
      (entry[issueType] ?? []).map((issue) => ({
        workspace: workspaceFor(entry.file),
        file: entry.file,
        issueType,
        symbol: issue.name,
        ...(issue.line === undefined ? {} : { line: issue.line }),
      })),
    ),
  )
  return findings.sort(compareFindings)
}

export function unneededExportFindings(
  production: DeadCodeFinding[],
  defaultMode: DeadCodeFinding[],
): DeadCodeFinding[] {
  const productionSymbols = new Set(
    production.map((finding) => `${finding.workspace}\0${finding.file}\0${finding.symbol}`),
  )
  return defaultMode
    .filter((finding) => finding.issueType === 'exports' || finding.issueType === 'types')
    .filter(
      (finding) =>
        !productionSymbols.has(`${finding.workspace}\0${finding.file}\0${finding.symbol}`),
    )
    .map((finding) => ({
      ...finding,
      issueType: finding.issueType === 'exports' ? 'unneededExports' : 'unneededTypes',
    }))
}

function compareFindings(a: DeadCodeFinding, b: DeadCodeFinding) {
  return (
    a.workspace.localeCompare(b.workspace) ||
    a.file.localeCompare(b.file) ||
    a.issueType.localeCompare(b.issueType) ||
    a.symbol.localeCompare(b.symbol)
  )
}

export function stableFinding(finding: DeadCodeFinding): DeadCodeFinding {
  const { line: _, ...stable } = finding
  return stable
}

function isDeadCodeFinding(value: unknown): value is DeadCodeFinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const finding = value as Record<string, unknown>
  return (
    Object.keys(finding).every((key) =>
      ['workspace', 'file', 'issueType', 'symbol'].includes(key),
    ) &&
    typeof finding.workspace === 'string' &&
    typeof finding.file === 'string' &&
    DEAD_CODE_ISSUE_TYPES.includes(finding.issueType as DeadCodeIssueType) &&
    typeof finding.symbol === 'string'
  )
}

export function parseCachedFindings(text: string | undefined): DeadCodeFinding[] | null {
  if (text === undefined) return null
  try {
    const value: unknown = JSON.parse(text)
    return Array.isArray(value) && value.every(isDeadCodeFinding) ? value : null
  } catch {
    return null
  }
}

export function cacheConfigurationHash(configs: Array<{ name: string; content: string }>) {
  const hash = createHash('sha256')
  for (const config of configs) {
    hash.update(config.name).update('\0').update(config.content).update('\0')
  }
  return hash.digest('hex')
}

export function deadCodeCacheKey(input: {
  commit: string
  knipVersion: string
  configurationHash: string
}) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

export type DeadCodeCacheEntry = { name: string; modifiedMs: number }

export function deadCodeCacheEntriesToRemove(
  entries: DeadCodeCacheEntry[],
  justWritten: string,
  keep: number,
) {
  const newestModifiedMs = Math.max(
    ...entries.filter((entry) => !entry.name.endsWith('.tmp')).map((entry) => entry.modifiedMs),
    Number.NEGATIVE_INFINITY,
  )
  const temporaryEntries = entries
    .filter((entry) => entry.name.endsWith('.tmp') && entry.modifiedMs < newestModifiedMs)
    .map((entry) => entry.name)
  const retained = new Set(
    entries
      .filter((entry) => !entry.name.endsWith('.tmp') && entry.name !== justWritten)
      .sort((a, b) => b.modifiedMs - a.modifiedMs || a.name.localeCompare(b.name))
      .slice(0, Math.max(0, keep - 1))
      .map((entry) => entry.name),
  )
  retained.add(justWritten)
  return [
    ...temporaryEntries,
    ...entries
      .filter((entry) => !entry.name.endsWith('.tmp') && !retained.has(entry.name))
      .map((entry) => entry.name),
  ]
}

export function productionSourcesAnalyzed(findings: DeadCodeFinding[]) {
  return !findings.some(
    (finding) => finding.issueType === 'dependencies' && finding.symbol === 'commander',
  )
}

const ENTRY_GLOB_CHARACTERS = /[*?{}[\]]/

export function missingLiteralProductionEntries(
  entries: readonly string[],
  seenFiles: ReadonlySet<string>,
): string[] {
  return entries
    .filter((entry) => entry.endsWith('!') && !entry.startsWith('!'))
    .map((entry) => entry.slice(0, -1))
    .filter((entry) => !ENTRY_GLOB_CHARACTERS.test(entry) && !seenFiles.has(entry))
}

export function deadCodeRatchetFinding(finding: DeadCodeFinding): Finding {
  return {
    file: `${finding.workspace}\0${finding.file}`,
    line: finding.line ?? 0,
    rule: `${finding.issueType}\0${finding.symbol}`,
    message: '',
  }
}

export function deadCodeChangeFacts(renames: Map<string, string>): ChangeFacts {
  return {
    renames: new Map(
      [...renames].map(([head, base]) => [
        `${workspaceFor(head)}\0${head}`,
        `${workspaceFor(base)}\0${base}`,
      ]),
    ),
    addedLines: new Map(),
  }
}
