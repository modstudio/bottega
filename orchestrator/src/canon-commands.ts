// concern: canon-commands
/** Knows canon command semantics over canon, lint, and evals. Must not know runs, routing, transports, the CLI, or worktrees. */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import type { Finding } from '../../shared/ratchet.ts'
import {
  allInjectChecks,
  allNumericLiterals,
  compilePack,
  diffPack,
  findingsForPack,
} from './canon.ts'
import { canonGitRoot, collectCanonLintInput, collectCanonTree } from './canon-files.ts'
import { type CanonRow, planHydration } from './canon-hydrate.ts'
import { classifyCanonFile, introducedCanonFindings, lintCanon } from './canon-lint.ts'
import { decideCanonWrite } from './canon-write-gate.ts'
import { listDocs, removeDoc, setDoc } from './docs.ts'
import { canonEvalsReport, runCanonEvals } from './evals.ts'
import { projectByName } from './projects.ts'

type CanonFlags = { has(name: string): boolean; flag(name: string): string | undefined }
type CanonPresentation = {
  log(...values: unknown[]): void
  exitCode(code: number): void
  cwd(): string
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

function canonRows(project: string): CanonRow[] {
  return listDocs({ scope: 'canon', subject: project }).map(({ slug, body }) => ({ slug, body }))
}

export function canonSlugsToRemove(currentSlugs: string[], treeSlugs: string[]): string[] {
  if (treeSlugs.length === 0) return []
  const tree = new Set(treeSlugs)
  return currentSlugs.filter((slug) => !tree.has(slug))
}

function printHydrationPlan(
  plan: ReturnType<typeof planHydration>,
  log: (...values: unknown[]) => void,
): void {
  for (const row of plan.writes) log(`write ${row.path}`)
  for (const row of plan.links) log(`link ${row.path} -> ${row.target}`)
  for (const path of plan.deletes) log(`delete ${path}`)
}

function applyHydration(root: string, plan: ReturnType<typeof planHydration>): void {
  for (const path of plan.deletes) rmSync(resolve(root, path))
  for (const { path, body } of plan.writes) {
    const target = resolve(root, path)
    mkdirSync(dirname(target), { recursive: true })
    const targetStat = statOrNull(target)
    if (targetStat?.isSymbolicLink()) rmSync(target)
    writeFileSync(target, body)
  }
  for (const { path, target } of plan.links) {
    const destination = resolve(root, path)
    mkdirSync(dirname(destination), { recursive: true })
    if (statOrNull(destination)) rmSync(destination, { recursive: true })
    symlinkSync(target, destination)
  }
}

function statOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function canonImportCommand(flags: CanonFlags, presentation: CanonPresentation): void {
  const project = requestedProject(flags)
  const reason = flags.flag('reason')
  if (!reason?.trim()) throw new Error('--reason is required')
  const requestedCwd = resolve(flags.flag('cwd') ?? project.path)
  const root = canonGitRoot(requestedCwd)
  const collected = collectCanonLintInput(root)
  const rows = collected.files
    .filter((file) => file.symlinkTarget === undefined && classifyCanonFile(file) !== null)
    .map(({ path, text }) => ({ slug: path, body: text }))
  if (rows.length === 0) {
    throw new Error(`refusing canon import: no canon rows found under --cwd ${requestedCwd}`)
  }
  const current = canonRows(project.name)
  const removals = canonSlugsToRemove(
    current.map(({ slug }) => slug),
    rows.map(({ slug }) => slug),
  )
  const findings = decideCanonWrite({
    current,
    next: rows,
    trackedPaths: collected.trackedPaths,
    packageScripts: collected.packageScripts,
    sourceTexts: collected.sourceTexts,
  })
  const bootstrap = current.length === 0
  for (const row of rows) {
    setDoc({
      scope: 'canon',
      subject: project.name,
      slug: row.slug,
      title: row.slug,
      body: row.body,
      delivery: 'demand',
      reason,
      canonSet: rows,
      allowCanonBootstrap: bootstrap,
    })
  }
  let removed = 0
  for (const slug of removals) {
    if (removeDoc('canon', project.name, slug, { reason })) {
      presentation.log(`removed ${slug}`)
      removed++
    }
  }
  presentation.log(`imported ${rows.length} canon rows, removed ${removed}`)
  if (bootstrap) {
    presentation.log(
      `empty canon store: bypassed introduced-findings comparison (${findings.length} findings)`,
    )
  }
}

function canonHydrateCommand(flags: CanonFlags, presentation: CanonPresentation): void {
  const project = requestedProject(flags)
  const requested = flags.flag('cwd')
  if (!requested) throw new Error('--cwd is required')
  const root = canonGitRoot(resolve(requested))
  if (realpathSync(root) === realpathSync(project.path)) {
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
  const count = plan.writes.length + plan.links.length + plan.deletes.length
  if (flags.has('check')) {
    if (count) presentation.exitCode(1)
    return
  }
  applyHydration(root, plan)
  presentation.log(`hydrated ${count} paths`)
}

function canonListCommand(flags: CanonFlags, presentation: CanonPresentation): void {
  const project = requestedProject(flags)
  for (const row of listDocs({ scope: 'canon', subject: project.name })) {
    const tier = classifyCanonFile({ path: row.slug, text: row.body })
    presentation.log(
      `${row.slug}  ${tier ?? 'invalid'}  ${Buffer.byteLength(row.body)}  ${row.updated_at}`,
    )
  }
}

export function canonLintCommand(flags: CanonFlags, presentation: CanonPresentation): void {
  const requestedCwd = resolve(flags.flag('cwd') ?? presentation.cwd())
  const root = canonGitRoot(requestedCwd)
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
    const result = diffPack({ job: jobName, cwd })
    if (has('json')) log(JSON.stringify(result))
    else {
      log(
        `canon ${result.job}/${result.project ?? '_'}: ${result.bytesDelta >= 0 ? '+' : ''}${result.bytesDelta} bytes`,
      )
      for (const doc of result.added)
        log(`  added ${doc.scope}/${doc.subject ?? '_'}/${doc.slug} revision ${doc.revisionId}`)
      for (const doc of result.removed)
        log(`  removed ${doc.scope}/${doc.subject ?? '_'}/${doc.slug} revision ${doc.revisionId}`)
      for (const doc of result.changed)
        log(`  changed ${doc.slug} revision ${doc.fromRevision} -> ${doc.toRevision}`)
    }
    return
  }
  throw new Error(
    'unknown: orch canon. Try import | hydrate | list | check | diff | eval | evals | lint',
  )
}

function canonStoreCommand(
  sub: string | undefined,
  flags: CanonFlags,
  presentation: CanonPresentation,
): boolean {
  if (sub === 'import') canonImportCommand(flags, presentation)
  else if (sub === 'hydrate') canonHydrateCommand(flags, presentation)
  else if (sub === 'list') canonListCommand(flags, presentation)
  else return false
  return true
}

export async function dispatchCanonCommand(
  argv: string[],
  flags: CanonFlags,
  presentation: CanonPresentation,
): Promise<void> {
  if (canonStoreCommand(argv[1], flags, presentation)) return
  await canonCommand(argv, flags, presentation)
}
