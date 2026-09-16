import { type Finding, fingerprint, introducedFindings } from '../../shared/ratchet'

export const DEAD_CODE_ISSUE_TYPES = [
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

export type DeadCodeIssueType = (typeof DEAD_CODE_ISSUE_TYPES)[number]
export type DeadCodeFinding = {
  workspace: string
  file: string
  issueType: DeadCodeIssueType
  symbol: string
  line?: number
}

type KnipItem = { name: string; line?: number }
type KnipReport = {
  issues: Array<{ file: string } & Partial<Record<DeadCodeIssueType, KnipItem[]>>>
}

function workspaceFor(file: string) {
  if (file.startsWith('hub/web/')) return 'hub/web'
  if (file.startsWith('orchestrator/')) return 'orchestrator'
  if (file.startsWith('hub/')) return 'hub'
  return '.'
}

export function normalizeKnipReport(
  report: KnipReport,
  issueTypes: readonly DeadCodeIssueType[] = DEAD_CODE_ISSUE_TYPES,
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

export function productionSourcesAnalyzed(findings: DeadCodeFinding[]) {
  return !findings.some(
    (finding) => finding.issueType === 'dependencies' && finding.symbol === 'commander',
  )
}

function ratchetFinding(finding: DeadCodeFinding): Finding {
  return {
    file: `${finding.workspace}\0${finding.file}`,
    line: finding.line ?? 0,
    rule: `${finding.issueType}\0${finding.symbol}`,
    message: '',
  }
}

function findingsByFingerprint(findings: DeadCodeFinding[]) {
  return new Map(findings.map((finding) => [fingerprint(ratchetFinding(finding)), finding]))
}

export function compareDeadCodeFindings(baseline: DeadCodeFinding[], current: DeadCodeFinding[]) {
  const introduced = introducedFindings(baseline.map(ratchetFinding), current.map(ratchetFinding))
  const vanished = introducedFindings(current.map(ratchetFinding), baseline.map(ratchetFinding))
  const currentByFingerprint = findingsByFingerprint(current)
  const baselineByFingerprint = findingsByFingerprint(baseline)
  return {
    introduced: introduced.map((finding) => currentByFingerprint.get(fingerprint(finding))!),
    vanished: vanished.map((finding) => baselineByFingerprint.get(fingerprint(finding))!),
  }
}
