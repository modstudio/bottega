// concern: canon-commands
/** Knows canon command semantics over canon, lint, and evals. Must not know runs, routing, transports, the CLI, or worktrees. */
import { existsSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { dirname, posix, resolve } from 'node:path'
import { z } from 'zod'
import { type Finding, introducedFindings } from '../../shared/ratchet.ts'
import {
  allInjectChecks,
  allNumericLiterals,
  compilePack,
  diffPack,
  findingsForPack,
} from './canon.ts'
import { type CanonFile, lintCanon } from './canon-lint.ts'
import { canonEvalsReport, runCanonEvals } from './evals.ts'
import { projectAt, projects } from './projects.ts'

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
})

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim()
    throw new Error(`git -C ${cwd} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
  return result.stdout.toString()
}

function isCanonPath(path: string): boolean {
  return (
    posix.basename(path) === 'AGENTS.md' ||
    posix.basename(path) === 'CLAUDE.md' ||
    /^\.agents\/(?:rules|contexts|reference)\/[^/]+\.md$/.test(path)
  )
}

function collectCanonFiles(root: string): CanonFile[] {
  const entries = git(root, ['ls-files', '-s', '-z'])
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^(\d+) [0-9a-f]+ \d+\t([\s\S]+)$/)
      if (!match) throw new Error(`could not parse git ls-files entry ${JSON.stringify(entry)}`)
      return { mode: match[1]!, path: match[2]! }
    })
    .filter(({ path }) => isCanonPath(path))
  const tracked = new Set(entries.map(({ path }) => path))
  return entries.map(({ mode, path }) => {
    const absolute = resolve(root, path)
    if (mode !== '120000') return { path, text: readFileSync(absolute, 'utf8') }
    const symlinkTarget = readlinkSync(absolute)
    const targetPath = posix.isAbsolute(symlinkTarget)
      ? posix.normalize(symlinkTarget)
      : posix.normalize(posix.join(posix.dirname(path), symlinkTarget))
    return {
      path,
      text:
        tracked.has(targetPath) && existsSync(resolve(root, targetPath))
          ? readFileSync(resolve(root, targetPath), 'utf8')
          : '',
      symlinkTarget,
    }
  })
}

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

export function canonLintCommand(flags: CanonFlags, presentation: CanonPresentation): void {
  const requestedCwd = resolve(flags.flag('cwd') ?? presentation.cwd())
  if (!projectAt(requestedCwd)) {
    throw new Error(
      `${requestedCwd} is not inside a registered project; cleared by: orch project add ${requestedCwd}`,
    )
  }
  const root = git(requestedCwd, ['rev-parse', '--show-toplevel']).trim()
  const result = lintCanon({
    files: collectCanonFiles(root),
    taskKeyPrefixes: projects().flatMap((project) => project.settings.keyPrefixes ?? []),
  })
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
    displayed = introducedFindings(baseline, result.findings)
  }
  if (flags.has('json')) presentation.log(JSON.stringify({ ...result, findings: displayed }))
  else {
    printMeasurements(result, presentation.log)
    printFindings(displayed, presentation.log)
  }
  if (flags.has('strict') && displayed.length) presentation.exitCode(1)
}

export async function canonCommand(
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
      log(`canon: ${pack.bytes}/${pack.budgetBytes} bytes`)
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
  throw new Error('unknown: orch canon. Try check | diff | eval | evals | lint')
}
