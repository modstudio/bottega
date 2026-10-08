// concern: canon-commands
/** Knows canon command semantics over canon, lint, and evals. Must not know runs, routing, transports, the CLI, or worktrees. */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import type { Finding } from '../../../shared/ratchet.ts'
import { requireAgent } from '../agent/agent-registry.ts'
import { workerLaunchEnv } from '../agent/worker-launch-env.ts'
import { hasCanonImportHistory, importCanon } from '../doc/canon-import.ts'
import { nonCurrentCanonCollisionRefusal } from '../doc/canon-import-collision.ts'
import { canonFindingsRefusal } from '../doc/doc-write-allowed.ts'
import { listDocs, signedInDocOwner } from '../doc/docs.ts'
import {
  isProjectRepository,
  projectAt,
  projectByName,
  projectRepositoryRefusal,
} from '../project/projects.ts'
import { productionWorkflowTree } from '../workflow/workflow-tree-store.ts'
import {
  acceptPackDiff,
  allInjectChecks,
  allNumericLiterals,
  compilePack,
  diffPack,
  findingsForPack,
} from './canon.ts'
import { applyHydration } from './canon-apply.ts'
import { auditRepositoryCanon, type CanonAuditResult } from './canon-audit.ts'
import { canonGitRoot, collectCanonLintInput, collectCanonTree } from './canon-files.ts'
import {
  composeCanonRows,
  hydrationDrift,
  mainCheckoutHydrationRefusal,
  planHydration,
} from './canon-hydrate.ts'
import { planCanonImport } from './canon-import-policy.ts'
import { classifyCanonFile, introducedCanonFindings, lintCanon } from './canon-lint.ts'
import { HARNESS_NAMES, type HarnessName, type LoadPlan, planHarnessLoad } from './canon-load.ts'
import { gatherHarnessLoadFacts, gatherWorkerHarnessLoadFacts } from './canon-load-files.ts'
import { storedRepositoryCanonRows } from './canon-stored-rows.ts'
import { canonEvalsReport, runCanonEvals } from './evals.ts'
import { userCanonHydrateCommand, userCanonImportCommand } from './user-canon-commands.ts'

type CanonFlags = { has(name: string): boolean; flag(name: string): string | undefined }
type CanonPresentation = {
  log(...values: unknown[]): void
  exitCode(code: number): void
  cwd(): string
}

const CANON_FLAG_NAMES = [
  'cwd',
  'job',
  'slug',
  'agent',
  'project',
  'user',
  'reason',
  'baseline',
  'accept',
  'all',
  'json',
  'force',
  'strict',
  'write-baseline',
  'check',
  'harness',
  'role',
  'dry-run',
] as const

function refuseUnsupportedFlags(flags: CanonFlags, accepted: readonly string[]): void {
  const allowed = new Set(accepted)
  const unsupported = CANON_FLAG_NAMES.filter((name) => flags.has(name) && !allowed.has(name))
  if (unsupported.length) {
    throw new Error(
      `unsupported canon import flag${unsupported.length === 1 ? '' : 's'}: ${unsupported.map((name) => `--${name}`).join(', ')}`,
    )
  }
}

function printCanonAudit(result: CanonAuditResult, log: (...values: unknown[]) => void): void {
  for (const project of result.projects) {
    log(`${project.project}: ${project.findings} findings, ${project.notes.length} new notes`)
    for (const text of project.notes) log(`  ${result.dryRun ? 'would file' : 'filed'} ${text}`)
  }
}

const findingSchema = z.object({
  file: z.string(),
  line: z.number().int(),
  rule: z.string(),
  message: z.string(),
  measuredBytes: z.number().int().nonnegative().optional(),
})

function printMeasurements(
  result: ReturnType<typeof lintCanon>,
  log: (...values: unknown[]) => void,
): void {
  const { tiers } = result.summary
  log('tiers')
  if (tiers.entry)
    log(`  entry       ${tiers.entry.bytes}/${tiers.entry.limit}  ${tiers.entry.path}`)
  log(`  always-on   ${tiers.alwaysOn.bytes}/${tiers.alwaysOn.limit}`)
  for (const [name, rows] of [
    ['rule', tiers.rules],
    ['context', tiers.contexts],
    ['reference', tiers.references],
    ['card', tiers.cards],
  ] as const) {
    for (const row of rows) log(`  ${name.padEnd(11)} ${row.bytes}/${row.limit}  ${row.path}`)
  }
  log('chains')
  for (const row of result.summary.chains)
    log(`  ${row.bytes}/${row.limit}  ${dirname(row.path) === '.' ? '.' : dirname(row.path)}`)
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

function requestedProject(flags: CanonFlags) {
  const name = flags.flag('project')
  if (!name) throw new Error('--project is required')
  const project = projectByName(name)
  if (!project) throw new Error(`unknown project ${JSON.stringify(name)}`)
  return project
}

function requestedRepositoryProject(flags: CanonFlags) {
  const project = requestedProject(flags)
  if (!isProjectRepository(project)) throw new Error(projectRepositoryRefusal(project)!)
  return project
}

function projectCanonImportPlan(
  project: NonNullable<ReturnType<typeof projectByName>>,
  requestedCwd: string,
) {
  const root = canonGitRoot(requestedCwd)
  const collected = collectCanonLintInput(root)
  const renderedRows = collected.files
    .filter((file) => file.symlinkTarget === undefined && classifyCanonFile(file) !== null)
    .map(({ path, text }) => ({ slug: path, body: text }))
  if (renderedRows.length === 0) {
    throw new Error(`refusing canon import: no canon rows found under --cwd ${requestedCwd}`)
  }
  const global = listDocs({ scope: 'canon', subject: null, status: 'current' })
  const globalBySlug = new Map(global.map((row) => [row.slug, row]))
  for (const row of renderedRows) {
    const globalRow = globalBySlug.get(row.slug)
    if (globalRow && globalRow.body !== row.body) {
      throw new Error(
        `refusing canon import: rendered ${row.slug} differs from canon/_/${row.slug}; edit the global canon row`,
      )
    }
  }
  const rows = renderedRows.filter((row) => !globalBySlug.has(row.slug))
  const allProjectRows = listDocs({ scope: 'canon', subject: project.name })
  const collision = nonCurrentCanonCollisionRefusal({
    rows: allProjectRows,
    desiredSlugs: rows.map((row) => row.slug),
    address: { kind: 'project', subject: project.name },
  })
  if (collision) throw new Error(collision)
  const projectRows = allProjectRows.filter((row) => row.status === 'current')
  const plan = planCanonImport({
    address: { kind: 'project' },
    current: projectRows.map(({ slug, body }) => ({ slug, body })),
    desired: rows,
    hasHistory: hasCanonImportHistory({
      kind: 'project',
      subject: project.name,
      projectId: project.id,
    }),
    surroundings: [{ global, project: [] }],
    trackedPaths: collected.trackedPaths,
    packageScripts: collected.packageScripts,
    sourceTexts: collected.sourceTexts,
    workflowSteps: productionWorkflowTree().steps.map(({ slug, body }) => ({ slug, body })),
  })
  return { plan, rows }
}

function canonRows(project: string) {
  return storedRepositoryCanonRows(project)
}

function printHydrationPlan(
  plan: ReturnType<typeof planHydration>,
  log: (...values: unknown[]) => void,
): void {
  for (const row of plan.writes) log(`write ${row.path}`)
  for (const row of plan.links) log(`link ${row.path} -> ${row.target}`)
  for (const path of plan.deletes) log(`delete ${path}`)
}

async function canonImportCommand(
  flags: CanonFlags,
  presentation: CanonPresentation,
): Promise<void> {
  if (flags.has('user')) {
    refuseUnsupportedFlags(flags, ['user', 'dry-run'])
    await userCanonImportCommand(flags, presentation)
    return
  }
  refuseUnsupportedFlags(flags, ['project', 'cwd', 'reason', 'dry-run'])
  const project = requestedRepositoryProject(flags)
  const reason = flags.flag('reason')
  if (!reason?.trim()) throw new Error('--reason is required')
  const requestedCwd = resolve(flags.flag('cwd') ?? project.path)
  const { plan, rows } = projectCanonImportPlan(project, requestedCwd)
  for (const row of rows) presentation.log(`write ${row.slug}`)
  for (const slug of plan.deletionSlugs) presentation.log(`delete ${slug}`)
  if (flags.has('dry-run')) {
    printFindings(plan.findings, presentation.log)
    presentation.log(`bootstrap: ${plan.bootstrap ? 'yes' : 'no'}`)
    if (plan.refusal) {
      presentation.log(
        plan.refusal === 'empty'
          ? 'refusing canon import: desired canon set is empty'
          : 'refusing canon import: introduced canon findings',
      )
      presentation.exitCode(1)
      return
    }
    presentation.log(`would import ${rows.length} canon rows, remove ${plan.deletionSlugs.length}`)
    return
  }
  if (plan.refusal === 'empty') throw new Error('refusing canon import: desired canon set is empty')
  if (plan.refusal === 'findings') throw new Error(canonFindingsRefusal(plan.findings)!)

  const result = await importCanon({
    address: { kind: 'project', subject: project.name, projectId: project.id },
    rows: rows.map((row) => ({ ...row, title: row.slug })),
    reason,
  })
  printFindings(result.findings, presentation.log)
  presentation.log(`imported ${result.rows.length} canon rows, removed ${result.deletions.length}`)
  if (result.bootstrap) {
    presentation.log(
      `empty canon store: bypassed introduced-findings comparison (${result.findings.length} findings)`,
    )
  }
}

async function canonHydrateCommand(
  flags: CanonFlags,
  presentation: CanonPresentation,
): Promise<void> {
  if (flags.has('user')) {
    await userCanonHydrateCommand(flags, presentation)
    return
  }
  const project = requestedRepositoryProject(flags)
  const requested = flags.flag('cwd')
  if (!requested) throw new Error('--cwd is required')
  const root = canonGitRoot(resolve(requested))
  if (
    mainCheckoutHydrationRefusal({
      mainCheckout: realpathSync(root) === realpathSync(project.path),
      check: flags.has('check'),
    })
  ) {
    throw new Error(
      `refusing to hydrate registered main checkout ${project.path}\n` +
        'invariant: canon hydration writes a disposable project tree, never the main checkout\n' +
        'cleared by: pass --cwd for a worktree',
    )
  }
  const plan = planHydration({
    rows: canonRows(project.name),
    tree: collectCanonTree(root),
  })
  printHydrationPlan(plan, presentation.log)
  const count = hydrationDrift(plan).length
  if (flags.has('check')) {
    if (count) presentation.exitCode(1)
    return
  }
  applyHydration(root, plan)
  presentation.log(`hydrated ${count} paths`)
}

async function canonListCommand(flags: CanonFlags, presentation: CanonPresentation): Promise<void> {
  const rows = flags.has('user')
    ? composeCanonRows(
        listDocs({ scope: 'canon', subject: null }),
        listDocs({ scope: 'canon', subject: null, owner: await signedInDocOwner() }),
        [],
      )
    : canonRows(requestedProject(flags).name)
  for (const row of rows) {
    const tier = classifyCanonFile({ path: row.slug, text: row.body })
    presentation.log(
      `${row.subject ?? '_'}  ${row.slug}  ${tier ?? 'invalid'}  ${Buffer.byteLength(row.body)}  ${row.updated_at}`,
    )
  }
}

export function canonLintCommand(flags: CanonFlags, presentation: CanonPresentation): void {
  const requestedCwd = resolve(flags.flag('cwd') ?? presentation.cwd())
  const root = canonGitRoot(requestedCwd)
  const namedProject = flags.flag('project')
  const project = namedProject ? projectByName(namedProject) : projectAt(root)
  if (namedProject && !project) throw new Error(`unknown project ${JSON.stringify(namedProject)}`)
  if (project) canonRows(project.name)
  const result = lintCanon(collectCanonLintInput(root))
  const baselineFlag = flags.flag('baseline')
  if ((flags.has('strict') || flags.has('write-baseline')) && !baselineFlag) {
    throw new Error('--strict and --write-baseline require --baseline FILE')
  }
  const baselinePath = baselineFlag ? resolve(presentation.cwd(), baselineFlag) : null
  if (flags.has('write-baseline')) {
    writeFileSync(baselinePath!, `${JSON.stringify(result.findings, null, 2)}\n`)
    presentation.log(`wrote ${result.findings.length} findings to ${baselinePath}`)
    return
  }
  let displayed = result.findings
  if (flags.has('strict')) {
    const baseline = findingSchema.array().parse(JSON.parse(readFileSync(baselinePath!, 'utf8')))
    displayed = introducedCanonFindings(baseline, result.findings)
  }
  if (flags.has('json')) presentation.log(JSON.stringify({ ...result, findings: displayed }))
  else {
    printMeasurements(result, presentation.log)
    printFindings(displayed, presentation.log)
  }
  if (flags.has('strict') && displayed.length) presentation.exitCode(1)
}

function canonDiffCommand(
  flags: CanonFlags,
  presentation: CanonPresentation,
  input: { job: string; cwd: string },
): void {
  const result = diffPack(input)
  if (flags.has('json')) presentation.log(JSON.stringify(result))
  else {
    presentation.log(
      `canon ${result.job}/${result.project ?? '_'}: ${result.bytesDelta >= 0 ? '+' : ''}${result.bytesDelta} bytes`,
    )
    for (const doc of result.added)
      presentation.log(
        `  added ${doc.scope}/${doc.subject ?? '_'}/${doc.slug} revision ${doc.revisionId}`,
      )
    for (const doc of result.removed)
      presentation.log(
        `  removed ${doc.scope}/${doc.subject ?? '_'}/${doc.slug} revision ${doc.revisionId}`,
      )
    for (const doc of result.changed)
      presentation.log(`  changed ${doc.slug} revision ${doc.fromRevision} -> ${doc.toRevision}`)
  }
  if (!flags.has('accept')) return
  const accepted = acceptPackDiff(result)
  if (accepted) {
    presentation.log(
      `accepted canon ${accepted.job}/${accepted.project ?? '_'}: stored ${accepted.docs.length} docs, ${accepted.bytes} bytes`,
    )
  } else {
    presentation.log(`canon ${result.job}/${result.project ?? '_'}: nothing to accept`)
  }
}

async function canonCommand(
  argv: string[],
  flags: CanonFlags,
  presentation: CanonPresentation,
): Promise<void> {
  const { has, flag } = flags
  const { log, exitCode } = presentation
  const sub = argv[1]
  const cwd = flag('cwd') ?? presentation.cwd()
  const jobName = flag('job') ?? 'understand'
  if (sub === 'eval') {
    const rows = await runCanonEvals({
      slug: flag('slug'),
      agent: flag('agent'),
      force: has('force'),
      project: flag('project'),
      cwd,
    })
    if (has('json')) log(JSON.stringify(rows))
    else {
      for (const row of rows) {
        const verdict = row.skipped ? 'skip' : row.pass ? 'pass' : 'fail'
        log(`${row.slug}  ${row.agent}  ${verdict}  ${row.why}  ${row.canonSha}`)
      }
    }
    if (rows.some((row) => !row.skipped && row.pass === false)) exitCode(1)
    return
  }
  if (sub === 'evals') {
    const report = canonEvalsReport()
    if (has('json')) log(JSON.stringify(report))
    else {
      for (const row of report.latest) {
        const good = report.last_known_good.find(
          (item) => item.slug === row.slug && item.agent === row.agent,
        )
        log(
          `${row.slug}  ${row.agent}  ${row.pass ? 'pass' : 'fail'}  ${row.why}  ${row.canon_sha}` +
            (good ? `  last-pass ${good.canon_sha}` : '  last-pass none'),
        )
      }
    }
    return
  }
  if (sub === 'check') {
    const pack = compilePack({ job: jobName, cwd })
    const rows = has('all') ? allInjectChecks() : findingsForPack(pack)
    const findings = rows.flatMap((row) =>
      row.findings.map((finding) => ({ doc: row.doc, ...finding })),
    )
    const numericReport = allNumericLiterals(cwd)
    const numericLiterals = numericReport.numericLiterals.filter(
      (hit) => hit.classification === 'RESTATED',
    )
    const result = {
      pack: {
        job: pack.job,
        project: pack.project,
        bytes: pack.bytes,
        canonBytes: pack.canonBytes,
        docBytes: pack.docBytes,
        budgetBytes: pack.budgetBytes,
        sha256: pack.sha256,
      },
      docs: rows,
      findings,
      numericLiterals,
      canonFiles: numericReport.canonFiles,
    }
    if (has('json')) log(JSON.stringify(result))
    else {
      log(
        `canon: ${pack.canonBytes} canon + ${pack.docBytes} docs = ${pack.bytes}/${pack.budgetBytes} bytes`,
      )
      for (const row of rows.filter((row) => row.findings.length)) {
        log(
          `${row.doc.scope}/${row.doc.subject ?? '_'}/${row.doc.slug} revision ${row.doc.revisionId}`,
        )
        for (const finding of row.findings) log(`  ${finding.kind}: ${finding.message}`)
      }
      log(
        `canon files: read ${numericReport.canonFiles.read.join(', ') || 'none'}` +
          `; missing ${numericReport.canonFiles.missing.join(', ') || 'none'}`,
      )
      log('numeric literals')
      for (const hit of numericLiterals) {
        log(`  ${hit.source}  ${hit.numeral}  ${hit.sentence}`)
      }
    }
    if (findings.length) exitCode(1)
    return
  }
  if (sub === 'diff') {
    canonDiffCommand(flags, presentation, { job: jobName, cwd })
    return
  }
  throw new Error(
    'unknown: orch canon. Try audit | mirror | import | hydrate | list | check | diff | eval | evals | lint | load',
  )
}

function requestedHarness(flags: CanonFlags): HarnessName | undefined {
  const value = flags.flag('harness')
  if (!value) return undefined
  if ((HARNESS_NAMES as readonly string[]).includes(value)) return value as HarnessName
  throw new Error(`unknown --harness ${JSON.stringify(value)}; use claude, codex, or grok`)
}

function printLoadPlans(plans: LoadPlan[], log: (...values: unknown[]) => void): void {
  for (const [index, plan] of plans.entries()) {
    if (index) log('')
    log(plan.harness)
    const files = [...plan.files].sort((left, right) => {
      const size = right.size - left.size
      return size !== 0 ? size : left.path.localeCompare(right.path)
    })
    for (const file of files) {
      const mark = file.external ? '  [external]' : ''
      log(`  ${file.size}  ${file.kind}  ${file.path}${mark}  ${file.reason}`)
    }
    const skipped = [...plan.skipped].sort((left, right) => {
      const size = right.size - left.size
      return size !== 0 ? size : left.path.localeCompare(right.path)
    })
    for (const row of skipped) log(`  skipped  ${row.size}  ${row.path}  ${row.reason}`)
    if (plan.limit === null) log(`  ${plan.total} ${plan.unit}  ${plan.status}`)
    else log(`  ${plan.total}/${plan.limit} ${plan.unit}  ${plan.status}`)
    for (const row of plan.cut) log(`  cut ${row.path}  ${row.omitted} ${plan.unit} omitted`)
  }
}

function canonLoadCommand(flags: CanonFlags, presentation: CanonPresentation): void {
  const requested = flags.flag('cwd')
  if (!requested) throw new Error('--cwd is required')
  const cwd = resolve(requested)
  const harness = requestedHarness(flags)
  const role = flags.flag('role') ?? 'architect'
  if (role !== 'architect' && role !== 'worker') {
    throw new Error(`unknown --role ${JSON.stringify(role)}; use architect or worker`)
  }
  const agent = flags.flag('agent')
  if (role === 'worker' && !agent) throw new Error('--agent is required with --role worker')
  const harnessName = agent ? (requireAgent(agent).harness ?? agent) : null
  const loadFacts =
    role === 'worker'
      ? gatherWorkerHarnessLoadFacts(cwd, harnessName!, {
          ...process.env,
          ...workerLaunchEnv(harnessName!),
        })
      : gatherHarnessLoadFacts(cwd, process.env)
  const names = harness
    ? [harness]
    : role === 'worker'
      ? [harnessName as HarnessName]
      : [...HARNESS_NAMES]
  const plans = names.map((name) => planHarnessLoad(loadFacts, name))
  if (flags.has('json')) {
    presentation.log(
      JSON.stringify({ cwd: loadFacts.directoryChain.at(-1) ?? cwd, harnesses: plans }),
    )
    return
  }
  printLoadPlans(plans, presentation.log)
}

async function canonStoreCommand(
  sub: string | undefined,
  flags: CanonFlags,
  presentation: CanonPresentation,
): Promise<boolean> {
  if (sub === 'import') await canonImportCommand(flags, presentation)
  else if (sub === 'hydrate') await canonHydrateCommand(flags, presentation)
  else if (sub === 'list') await canonListCommand(flags, presentation)
  else return false
  return true
}

export async function dispatchCanonCommand(
  argv: string[],
  flags: CanonFlags,
  presentation: CanonPresentation,
): Promise<void> {
  if (argv[1] === 'mirror') {
    refuseUnsupportedFlags(flags, ['project', 'dry-run'])
    const { mirrorRepositoryCanon } = await import('./canon-mirror.ts')
    const results = await mirrorRepositoryCanon({
      project: flags.flag('project'),
      dryRun: flags.has('dry-run'),
    })
    for (const result of results) presentation.log(`${result.project}: ${result.text}`)
    if (results.some((result) => result.failed)) presentation.exitCode(1)
    return
  }
  if (argv[1] === 'audit') {
    const result = await auditRepositoryCanon({ dryRun: flags.has('dry-run') })
    if (flags.has('json')) presentation.log(JSON.stringify(result))
    else printCanonAudit(result, presentation.log)
    return
  }
  if (argv[1] === 'load') {
    canonLoadCommand(flags, presentation)
    return
  }
  if (await canonStoreCommand(argv[1], flags, presentation)) return
  await canonCommand(argv, flags, presentation)
}
