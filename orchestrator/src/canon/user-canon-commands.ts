// concern: user-canon-commands
/** Knows user canon import and hydration command semantics. Must not know runs, routing, transports, the CLI, or worktrees. */
import type { Finding } from '../../../shared/ratchet.ts'
import { listDocs, signedInDocOwner } from '../doc/docs.ts'
import { importUserCanon } from '../doc/user-canon-import.ts'
import { lintCanon } from './canon-lint.ts'
import { mapUserCanonPath, stripUserCanonManagedMarker } from './user-canon-home.ts'
import {
  applyUserCanonHomePlan,
  claudeHomeFromEnvironment,
  collectUserCanonHome,
  planUserCanonHome,
} from './user-canon-home-files.ts'

type UserCanonFlags = { has(name: string): boolean }
type UserCanonPresentation = {
  log(...values: unknown[]): void
  exitCode(code: number): void
}

function printFindings(findings: Finding[], log: (...values: unknown[]) => void): void {
  if (!findings.length) {
    log('findings: none')
    return
  }
  const grouped = Map.groupBy(findings, (finding) => finding.rule)
  log('findings')
  for (const [rule, rows] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    log(`  ${rule} (${rows.length})`)
    for (const finding of rows) log(`    ${finding.file}:${finding.line}  ${finding.message}`)
  }
}

export async function userCanonImportCommand(
  flags: UserCanonFlags,
  presentation: UserCanonPresentation,
): Promise<void> {
  const owner = await signedInDocOwner()
  const claudeHome = claudeHomeFromEnvironment(process.env)
  const files = collectUserCanonHome(claudeHome)
  if (files.length === 0) {
    throw new Error(`refusing user canon import: no canon files found under ${claudeHome}`)
  }
  const rows = files.map(({ slug, text }) => ({
    slug,
    body: stripUserCanonManagedMarker(text),
  }))
  const currentRows = listDocs({ scope: 'canon', subject: null, owner })
  const importedSlugs = new Set(rows.map(({ slug }) => slug))
  const mappedCurrent = currentRows.filter(({ slug }) =>
    mapUserCanonPath({ kind: 'canon', path: slug }),
  )
  const removals = mappedCurrent.filter(({ slug }) => !importedSlugs.has(slug))
  const previewFindings = lintCanon({
    files: rows.map(({ slug, body }) => ({ path: slug, text: body })),
    trackedPaths: [],
    packageScripts: [],
    sourceTexts: [],
  }).findings

  for (const row of rows) presentation.log(`write ${row.slug}`)
  for (const row of removals) presentation.log(`delete ${row.slug}`)
  if (flags.has('dry-run')) printFindings(previewFindings, presentation.log)
  if (flags.has('dry-run')) {
    presentation.log(`would import ${rows.length} canon rows, remove ${removals.length}`)
    return
  }

  const reason = 'imported from Claude home'
  const result = await importUserCanon({
    owner,
    rows: rows.map((row) => ({ ...row, title: row.slug })),
    reason,
  })
  printFindings(result.findings, presentation.log)
  presentation.log(`imported ${result.rows.length} canon rows, removed ${result.deletions.length}`)
  if (result.bootstrap) {
    presentation.log(
      `empty user canon store: bypassed introduced-findings comparison (${result.findings.length} findings)`,
    )
  }
}

export async function userCanonHydrateCommand(
  flags: UserCanonFlags,
  presentation: UserCanonPresentation,
): Promise<void> {
  const owner = await signedInDocOwner()
  const claudeHome = claudeHomeFromEnvironment(process.env)
  const plan = planUserCanonHome({
    claudeHome,
    rows: listDocs({ scope: 'canon', subject: null, owner }),
    files: collectUserCanonHome(claudeHome),
  })
  for (const row of plan.writes) presentation.log(`write ${row.path}`)
  for (const row of plan.deletes) presentation.log(`delete ${row.path}`)
  const count = plan.writes.length + plan.deletes.length
  if (flags.has('check')) {
    if (count) presentation.exitCode(1)
    return
  }
  applyUserCanonHomePlan(plan)
  presentation.log(`hydrated ${count} paths`)
}
