// concern: user-canon-commands
/** Knows user canon import and hydration command semantics. Must not know runs, routing, transports, the CLI, or worktrees. */
import type { Finding } from '../../../shared/ratchet.ts'
import { listDocs, removeDoc, setDoc, signedInDocOwner } from '../doc/docs.ts'
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
  const retained = currentRows.filter(
    ({ slug }) => !mapUserCanonPath({ kind: 'canon', path: slug }),
  )
  const removals = mappedCurrent.filter(({ slug }) => !importedSlugs.has(slug))
  const nextRows = [...retained, ...rows]
  const findings = lintCanon({
    files: rows.map(({ slug, body }) => ({ path: slug, text: body })),
    trackedPaths: [],
    packageScripts: [],
    sourceTexts: [],
  }).findings

  for (const row of rows) presentation.log(`write ${row.slug}`)
  for (const row of removals) presentation.log(`delete ${row.slug}`)
  printFindings(findings, presentation.log)
  if (flags.has('dry-run')) {
    presentation.log(`would import ${rows.length} canon rows, remove ${removals.length}`)
    return
  }

  const bootstrap = currentRows.length === 0
  const reason = 'imported from Claude home'
  const currentBySlug = new Map(currentRows.map((row) => [row.slug, row]))
  for (const row of rows) {
    await setDoc({
      scope: 'canon',
      subject: null,
      owner,
      slug: row.slug,
      title: row.slug,
      body: row.body,
      delivery: 'demand',
      reason,
      canonSet: nextRows,
      allowCanonBootstrap: bootstrap,
      expectedRevision: currentBySlug.get(row.slug)?.revision ?? undefined,
    })
  }
  let removed = 0
  for (const row of removals) {
    if (
      await removeDoc(
        'canon',
        null,
        row.slug,
        { reason, expectedRevision: row.revision ?? undefined },
        owner,
      )
    ) {
      removed++
    }
  }
  presentation.log(`imported ${rows.length} canon rows, removed ${removed}`)
  if (bootstrap) {
    presentation.log(
      `empty user canon store: bypassed introduced-findings comparison (${findings.length} findings)`,
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
