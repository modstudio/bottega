// concern: canon-write-gate
/** Knows the pure canon write decision. Must not know filesystems, stores, commands, runs, routing, or transports. */
import { posix } from 'node:path'
import { generatedLinks } from './canon-hydrate.ts'
import {
  type CanonFinding,
  type CanonLintInput,
  type CanonSourceText,
  introducedCanonFindings,
  lintCanon,
} from './canon-lint.ts'
import {
  CLAUDE_COMBINED_NOTICE_CHARS,
  type HarnessLoadFacts,
  planHarnessLoad,
} from './canon-load.ts'
import { mapUserCanonPath } from './user-canon-home.ts'

type Row = { slug: string; body: string }
export type WorkflowStepBody = { slug: string; body: string }

const SYNTHETIC_REPO = '/repo'
const SYNTHETIC_CLAUDE_HOME = '/home/.claude'

function userCanonLint(rows: Row[]): CanonFinding[] {
  return lintCanon({
    files: rows.map(({ slug, body }) => ({ path: slug, text: body })),
    trackedPaths: [],
    packageScripts: [],
    sourceTexts: [],
  }).findings.filter(({ rule }) => rule !== 'canon/size-always-on')
}

function repoLoadCandidates(rows: Row[]): Array<{ path: string; text: string; realPath: string }> {
  const candidates = rows.map(({ slug, body }) => ({
    path: `${SYNTHETIC_REPO}/${slug}`,
    text: body,
    realPath: `${SYNTHETIC_REPO}/${slug}`,
  }))
  for (const link of generatedLinks(rows)) {
    const target = posix.normalize(posix.join(posix.dirname(link.path), link.target))
    for (const row of rows) {
      if (row.slug !== target && !row.slug.startsWith(`${target}/`)) continue
      const suffix = row.slug.slice(target.length).replace(/^\//, '')
      candidates.push({
        path: `${SYNTHETIC_REPO}/${posix.join(link.path, suffix)}`,
        text: row.body,
        realPath: `${SYNTHETIC_REPO}/${row.slug}`,
      })
    }
  }
  return candidates
}

function combinedClaudePlan(user: Row[], around: { global: Row[]; project: Row[] }) {
  const candidates = [
    ...repoLoadCandidates([...around.global, ...around.project]),
    ...user.flatMap(({ slug, body }) => {
      const mapped = mapUserCanonPath({ kind: 'canon', path: slug })
      if (!mapped) return []
      const path = `${SYNTHETIC_CLAUDE_HOME}/${mapped}`
      return [{ path, text: body, realPath: path }]
    }),
  ].map(({ path, text, realPath }) => ({ path, text, symlink: path !== realPath, realPath }))
  const facts: HarnessLoadFacts = {
    files: candidates,
    directoryChain: [SYNTHETIC_REPO],
    home: {
      claude: SYNTHETIC_CLAUDE_HOME,
      grok: '/home/.grok',
      codex: '/home/.codex',
    },
    env: { grokClaudeAgentsEnabled: true, grokClaudeRulesEnabled: true },
  }
  return planHarnessLoad(facts, 'claude')
}

function combinedLoadFindings(
  current: Row[],
  next: Row[],
  around: { global: Row[]; project: Row[] },
): CanonFinding[] {
  const findings = (rows: Row[]): CanonFinding[] => {
    const plan = combinedClaudePlan(rows, around)
    if (plan.status !== 'over') return []
    return [
      {
        file: rows[0]?.slug ?? 'AGENTS.md',
        line: 1,
        rule: 'canon/size-harness-load',
        message: `Claude Code combined always-on load ${plan.total.toLocaleString('en-US')} chars; limit ${CLAUDE_COMBINED_NOTICE_CHARS.toLocaleString('en-US')}`,
        measuredBytes: plan.total,
      },
    ]
  }
  return introducedCanonFindings(findings(current), findings(next))
}

/** Rules that inspect tracked paths, source identifiers, or package scripts. */
const TREE_DEPENDENT_CANON_RULES = [
  'canon/context-path-glob',
  'canon/reference-path',
  'canon/reference-heading',
  'canon/reference-symbol',
  'canon/reference-code',
  'canon/reference-script',
] as const

function treeFactsSupplied(input: {
  trackedPaths?: string[]
  packageScripts?: string[]
  sourceTexts?: CanonSourceText[]
}): boolean {
  return (
    input.trackedPaths !== undefined ||
    input.packageScripts !== undefined ||
    input.sourceTexts !== undefined
  )
}

type CanonTreeFacts = Pick<CanonLintInput, 'trackedPaths' | 'packageScripts' | 'sourceTexts'>

function factsForCanonRows(
  rows: Row[],
  knownCanonPaths: Set<string>,
  facts: CanonTreeFacts,
  sourceTexts: CanonSourceText[],
): CanonLintInput {
  const rowPaths = new Set(rows.map(({ slug }) => slug))
  return {
    files: rows.map(({ slug, body }) => ({ path: slug, text: body })),
    trackedPaths: [...facts.trackedPaths.filter((path) => !knownCanonPaths.has(path)), ...rowPaths],
    packageScripts: facts.packageScripts,
    sourceTexts,
  }
}

/** Decides one complete next repository-canon set, including its shared workflow citers. */
export function decideNextCanonSet(input: {
  current: Row[]
  next: Row[]
  trackedPaths?: string[]
  packageScripts?: string[]
  sourceTexts?: CanonSourceText[]
  workflowSteps?: WorkflowStepBody[]
}): CanonFinding[] {
  const knownCanonPaths = new Set([...input.current, ...input.next].map(({ slug }) => slug))
  const suppliedFacts = {
    trackedPaths: input.trackedPaths ?? [],
    packageScripts: input.packageScripts ?? [],
    sourceTexts: input.sourceTexts ?? [],
  }
  const sourceTexts = suppliedFacts.sourceTexts.filter(({ path }) => !knownCanonPaths.has(path))
  const currentFacts = factsForCanonRows(input.current, knownCanonPaths, suppliedFacts, sourceTexts)
  const nextFacts = factsForCanonRows(input.next, knownCanonPaths, suppliedFacts, sourceTexts)
  const referenceFiles = (input.workflowSteps ?? []).map(({ slug, body }) => ({
    path: `workflow step ${slug}`,
    text: body,
  }))
  currentFacts.referenceFiles = referenceFiles
  nextFacts.referenceFiles = referenceFiles
  const findings = introducedCanonFindings(
    lintCanon(currentFacts).findings,
    lintCanon(nextFacts).findings,
  )
  if (treeFactsSupplied(input)) return findings
  const skipped = new Set<string>(TREE_DEPENDENT_CANON_RULES)
  return findings.filter((finding) => !skipped.has(finding.rule))
}

/** Decides whether removing rows strands canon or shared-workflow references. */
export function decideCanonRemoval(input: {
  current: Row[]
  next: Row[]
  workflowSteps?: WorkflowStepBody[]
}): CanonFinding[] {
  const lint = (rows: Row[]) =>
    lintCanon({
      files: rows.map(({ slug, body }) => ({ path: slug, text: body })),
      referenceFiles: (input.workflowSteps ?? []).map(({ slug, body }) => ({
        path: `workflow step ${slug}`,
        text: body,
      })),
      trackedPaths: rows.map(({ slug }) => slug),
      packageScripts: [],
      sourceTexts: [],
    }).findings
  return introducedCanonFindings(lint(input.current), lint(input.next)).filter(({ rule }) =>
    rule.startsWith('canon/reference-'),
  )
}

export function decideUserCanonImport(input: {
  current: Row[]
  next: Row[]
  surroundings?: Array<{ global: Row[]; project: Row[] }>
}): {
  bootstrap: boolean
  findings: CanonFinding[]
} {
  const surroundings = input.surroundings ?? [{ global: [], project: [] }]
  const bootstrap = input.current.length === 0
  const findings: CanonFinding[] = []
  const changedFindings = (current: Row[], next: Row[]) =>
    introducedCanonFindings(userCanonLint(current), userCanonLint(next))
  for (const around of surroundings) {
    if (bootstrap) {
      findings.push(...changedFindings([], input.next))
      findings.push(...combinedLoadFindings([], input.next, around))
      continue
    }
    let working = input.current
    for (const row of input.next) {
      const changed = [...working.filter(({ slug }) => slug !== row.slug), row]
      findings.push(...changedFindings(working, changed))
      findings.push(...combinedLoadFindings(working, changed, around))
      working = changed
    }
    findings.push(...changedFindings(working, input.next))
    findings.push(...combinedLoadFindings(working, input.next, around))
  }
  return {
    bootstrap,
    findings: [...new Map(findings.map((finding) => [JSON.stringify(finding), finding])).values()],
  }
}
