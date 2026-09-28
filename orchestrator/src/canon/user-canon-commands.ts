// concern: user-canon-commands
/** Knows user canon import and hydration command semantics. Must not know runs, routing, transports, the CLI, or worktrees. */
import type { Finding } from '../../../shared/ratchet.ts'
import { resolveRunsDirectory } from '../../../shared/state-directory.ts'
import { hasCanonImportHistory, importCanon } from '../doc/canon-import.ts'
import { userCanonWriteTargets } from '../doc/doc-write-allowed.ts'
import { listDocs, signedInDocOwner } from '../doc/docs.ts'
import { projects } from '../project/projects.ts'
import { planCanonImport } from './canon-import-policy.ts'
import { stripUserCanonManagedMarker } from './user-canon-home.ts'
import {
  applyUserCanonHomePlans,
  collectUserCanonHome,
  planUserCanonHome,
  userCanonHomeInstallationStatus,
  userCanonHomeOverridesStatus,
  userCanonHomePlanDrift,
  userCanonHomesFromEnvironment,
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
  const claudeHome = userCanonHomesFromEnvironment(
    process.env,
    resolveRunsDirectory(process.env),
  )[0]!
  const files = collectUserCanonHome(claudeHome)
  if (files.length === 0) {
    throw new Error(`refusing user canon import: no canon files found under ${claudeHome.path}`)
  }
  const rows = files.map(({ slug, text }) => ({
    slug,
    body: stripUserCanonManagedMarker(text),
  }))
  const currentRows = listDocs({ scope: 'canon', subject: null, owner })
  const global = listDocs({ scope: 'canon', subject: null }).map(({ slug, body }) => ({
    slug,
    body,
  }))
  const surroundings = userCanonWriteTargets(projects()).map((project) => ({
    global,
    project: project
      ? listDocs({ scope: 'canon', subject: project.name }).map(({ slug, body }) => ({
          slug,
          body,
        }))
      : [],
  }))
  const preview = planCanonImport({
    address: { kind: 'user' },
    current: currentRows.map(({ slug, body }) => ({ slug, body })),
    desired: rows,
    hasHistory: hasCanonImportHistory({ kind: 'user', owner }),
    surroundings,
  })

  for (const row of rows) presentation.log(`write ${row.slug}`)
  for (const slug of preview.deletionSlugs) presentation.log(`delete ${slug}`)
  if (flags.has('dry-run')) {
    printFindings(preview.findings, presentation.log)
    if (preview.refusal) {
      presentation.log(
        preview.refusal === 'empty'
          ? 'refusing user canon import: desired canon set is empty'
          : 'refusing user canon import: introduced canon findings',
      )
      presentation.exitCode(1)
      return
    }
    presentation.log(
      `would import ${rows.length} canon rows, remove ${preview.deletionSlugs.length}`,
    )
    return
  }

  if (preview.refusal === 'empty') {
    throw new Error('refusing user canon import: desired canon set is empty')
  }
  if (preview.refusal === 'findings') {
    throw new Error('refusing user canon import: introduced canon findings')
  }

  const reason = 'imported from Claude home'
  const result = await importCanon({
    address: { kind: 'user', owner },
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
  if (flags.has('force')) {
    throw new Error('unknown flag for orch canon hydrate --user: --force')
  }
  const owner = await signedInDocOwner()
  const homes = userCanonHomesFromEnvironment(process.env, resolveRunsDirectory(process.env))
  const overrideStatus = userCanonHomeOverridesStatus(homes)
  if (overrideStatus) presentation.log(overrideStatus)
  const rows = listDocs({ scope: 'canon', subject: null, owner })
  const plans = homes
    .filter((home) => {
      const status = userCanonHomeInstallationStatus(home)
      if (status) presentation.log(status)
      return home.installed
    })
    .map((home) =>
      planUserCanonHome({
        home,
        rows,
        files: collectUserCanonHome(home),
        adopt: flags.has('adopt'),
      }),
    )
  for (const plan of plans) {
    for (const row of plan.writes) presentation.log(`write ${row.path}`)
    for (const row of plan.adopts) presentation.log(`adopt ${row.path}`)
    for (const row of plan.deletes) presentation.log(`delete ${row.path}`)
  }
  const count = plans.reduce((sum, plan) => sum + userCanonHomePlanDrift(plan), 0)
  if (flags.has('check')) {
    if (count) presentation.exitCode(1)
    return
  }
  const dryRun = flags.has('dry-run')
  const result = applyUserCanonHomePlans(plans, process.env, dryRun)
  for (const path of result.backups) presentation.log(`backup ${path}`)
  for (const failure of result.cleanupFailures) {
    presentation.log(`quarantine cleanup failed; committed hydrate retained ${failure}`)
  }
  presentation.log(`${dryRun ? 'would hydrate' : 'hydrated'} ${count} paths`)
}
